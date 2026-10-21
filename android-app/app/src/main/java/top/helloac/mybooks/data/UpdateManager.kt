package top.helloac.mybooks.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import retrofit2.HttpException
import top.helloac.mybooks.BuildConfig
import java.io.File
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit

sealed interface UpdateState {
    data object Idle : UpdateState
    data class Checking(val manual: Boolean) : UpdateState
    data class Available(val manifest: UpdateManifest, val force: Boolean) : UpdateState
    data class Downloading(val manifest: UpdateManifest, val force: Boolean, val progress: Float) : UpdateState
    data class Ready(val manifest: UpdateManifest, val force: Boolean, val file: File) : UpdateState
    data class Failed(
        val message: String,
        val manifest: UpdateManifest?,
        val file: File?,
        val force: Boolean,
    ) : UpdateState

    data class UpToDate(val versionName: String) : UpdateState
}

class UpdateManager(
    private val context: Context,
    private val settingsStore: SettingsStore,
    private val api: ApiService,
) {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var checkJob: Job? = null
    private var downloadJob: Job? = null

    private val downloadClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    val currentVersionCode: Int = BuildConfig.VERSION_CODE
    val currentVersionName: String = BuildConfig.VERSION_NAME

    fun checkOnLaunch() {
        val elapsed = System.currentTimeMillis() - settingsStore.lastUpdateCheck()
        if (elapsed < CHECK_INTERVAL_MS) return
        check(manual = false)
    }

    fun check(manual: Boolean) {
        if (checkJob?.isActive == true || downloadJob?.isActive == true) return
        checkJob = scope.launch {
            _state.value = UpdateState.Checking(manual)
            try {
                val manifest = api.getUpdateManifest(System.currentTimeMillis()).toManifest()
                settingsStore.setLastUpdateCheck(System.currentTimeMillis())
                val force = manifest.force || currentVersionCode < manifest.minSupportedVersionCode
                if (manifest.versionCode > currentVersionCode && manifest.apkUrl.isNotBlank()) {
                    _state.value = UpdateState.Available(manifest, force)
                } else if (manual) {
                    _state.value = UpdateState.UpToDate(manifest.versionName.ifBlank { currentVersionName })
                } else {
                    _state.value = UpdateState.Idle
                }
            } catch (e: HttpException) {
                if (manual) {
                    _state.value = if (e.code() == 404) {
                        UpdateState.Failed("服务器还没有发布更新清单", null, null, force = false)
                    } else {
                        UpdateState.Failed("检查更新失败（HTTP ${e.code()}）", null, null, force = false)
                    }
                } else {
                    _state.value = UpdateState.Idle
                }
            } catch (e: Exception) {
                if (manual) {
                    _state.value = UpdateState.Failed("无法连接更新服务器，请检查网络", null, null, force = false)
                } else {
                    _state.value = UpdateState.Idle
                }
            }
        }
    }

    fun download() {
        val available = _state.value as? UpdateState.Available ?: return
        if (downloadJob?.isActive == true) return
        val manifest = available.manifest
        val force = available.force
        val url = resolveUrl(manifest.apkUrl)
        if (url == null) {
            _state.value = UpdateState.Failed("更新包地址无效", manifest, null, force)
            return
        }
        downloadJob = scope.launch {
            _state.value = UpdateState.Downloading(manifest, force, 0f)
            val dir = File(context.cacheDir, "updates").apply { mkdirs() }
            val file = File(dir, "my-books-${manifest.versionCode}.apk")
            val temp = File(dir, "my-books-${manifest.versionCode}.apk.part")
            try {
                withContext(Dispatchers.IO) {
                    val request = Request.Builder().url(url).build()
                    downloadClient.newCall(request).execute().use { response ->
                        if (!response.isSuccessful) error("下载失败（HTTP ${response.code}）")
                        val body = response.body ?: error("下载失败：响应为空")
                        val total = body.contentLength().takeIf { it > 0 } ?: manifest.size
                        var downloaded = 0L
                        var lastReport = 0L
                        temp.outputStream().use { output ->
                            body.byteStream().use { input ->
                                val buffer = ByteArray(64 * 1024)
                                while (true) {
                                    val read = input.read(buffer)
                                    if (read < 0) break
                                    output.write(buffer, 0, read)
                                    downloaded += read
                                    if (total > 0) {
                                        val now = System.currentTimeMillis()
                                        if (now - lastReport > 120) {
                                            lastReport = now
                                            val progress = (downloaded.toFloat() / total).coerceIn(0f, 1f)
                                            _state.value = UpdateState.Downloading(manifest, force, progress)
                                        }
                                    }
                                }
                            }
                        }
                        if (manifest.sha256.isNotBlank()) {
                            val actual = sha256(temp)
                            if (!actual.equals(manifest.sha256, ignoreCase = true)) {
                                temp.delete()
                                error("安装包校验失败，请重试")
                            }
                        }
                    }
                }
                if (file.exists()) file.delete()
                if (!temp.renameTo(file)) error("安装包保存失败")
                _state.value = UpdateState.Ready(manifest, force, file)
            } catch (e: CancellationException) {
                temp.delete()
                throw e
            } catch (e: Exception) {
                temp.delete()
                _state.value = UpdateState.Failed(e.message ?: "下载失败，请重试", manifest, null, force)
            }
        }
    }

    fun cancelDownload() {
        val downloading = _state.value as? UpdateState.Downloading ?: return
        if (downloading.force) return
        downloadJob?.cancel()
        downloadJob = null
        _state.value = UpdateState.Available(downloading.manifest, force = false)
    }

    fun install() {
        val ready = _state.value as? UpdateState.Ready ?: return
        launchInstaller(ready.file, ready.manifest, ready.force)
    }

    fun retry() {
        val failed = _state.value as? UpdateState.Failed ?: return
        val file = failed.file
        val manifest = failed.manifest
        if (file != null && manifest != null && file.exists()) {
            launchInstaller(file, manifest, failed.force)
        } else if (manifest != null) {
            _state.value = UpdateState.Available(manifest, failed.force)
            download()
        }
    }

    fun dismiss() {
        val force = when (val current = _state.value) {
            is UpdateState.Available -> current.force
            is UpdateState.Downloading -> current.force
            is UpdateState.Ready -> current.force
            is UpdateState.Failed -> current.force
            else -> false
        }
        if (!force) _state.value = UpdateState.Idle
    }

    private fun launchInstaller(file: File, manifest: UpdateManifest, force: Boolean) {
        if (!context.packageManager.canRequestPackageInstalls()) {
            _state.value = UpdateState.Failed(
                "请允许“Mybooks”安装未知来源应用，然后返回重试",
                manifest,
                file,
                force,
            )
            runCatching {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${context.packageName}"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            return
        }
        try {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file,
            )
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (e: Exception) {
            _state.value = UpdateState.Failed(
                "无法启动安装器：${e.message ?: "未知错误"}",
                manifest,
                file,
                force,
            )
        }
    }

    private fun resolveUrl(raw: String): String? {
        if (raw.isBlank()) return null
        if (raw.startsWith("http://") || raw.startsWith("https://")) return raw
        return settingsStore.settings.value.baseUrl.trimEnd('/') + "/" + raw.trimStart('/')
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") {
            String.format(Locale.US, "%02x", it.toInt() and 0xff)
        }
    }

    companion object {
        private const val CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000L
    }
}
