package top.helloac.mybooks.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.ui.common.MetaText
import top.helloac.mybooks.ui.common.SectionHeader
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.HorizontalDivider
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.IconButton
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.SmallTopAppBar
import top.yukonga.miuix.kmp.basic.SnackbarHost
import top.yukonga.miuix.kmp.basic.SnackbarHostState
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Back
import top.yukonga.miuix.kmp.preference.RadioButtonPreference

@Composable
fun SettingsScreen(
    container: AppContainer,
    onBack: () -> Unit,
) {
    val settings = container.settingsStore.settings
    var baseUrl by remember { mutableStateOf(settings.value.baseUrl) }
    var themeMode by remember { mutableIntStateOf(settings.value.themeMode) }
    var notesRepo by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        runCatching { container.repository.serverSettings() }
            .onSuccess { if (!it.notesRepo.isNullOrBlank()) notesRepo = it.notesRepo }
    }

    Scaffold(
        topBar = {
            SmallTopAppBar(
                title = "设置",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(imageVector = MiuixIcons.Back, contentDescription = "返回")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item("server-title") {
                SectionHeader("服务器")
            }
            item("url") {
                TextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = "服务器地址",
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
            }
            if (notesRepo != null) {
                item("notes-repo") {
                    notesRepo?.let {
                        MetaText(
                            text = "心得仓库：$it",
                            modifier = Modifier.padding(horizontal = 4.dp),
                        )
                    }
                }
            }
            item("actions") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = {
                            container.settingsStore.save(
                                settings.value.copy(baseUrl = baseUrl),
                            )
                            baseUrl = container.settingsStore.settings.value.baseUrl
                            scope.launch { snackbarHostState.showSnackbar("已保存") }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColorsPrimary(),
                    ) {
                        Text("保存")
                    }
                    TextButton(
                        text = if (testing) "测试中…" else "测试连接",
                        onClick = {
                            if (testing) return@TextButton
                            testing = true
                            scope.launch {
                                try {
                                    val stats = container.repository.stats()
                                    snackbarHostState.showSnackbar("连接成功：${stats.total} 本藏书")
                                } catch (e: Exception) {
                                    snackbarHostState.showSnackbar(e.message ?: "连接失败")
                                } finally {
                                    testing = false
                                }
                            }
                        },
                    )
                }
            }
            item("theme-title") {
                SectionHeader("外观")
            }
            item("theme") {
                Card(
                    cornerRadius = 16.dp,
                    insideMargin = PaddingValues(0.dp),
                ) {
                    val modes = listOf(
                        "跟随系统" to 0,
                        "浅色" to 1,
                        "深色" to 2,
                    )
                    modes.forEachIndexed { index, (label, mode) ->
                        RadioButtonPreference(
                            title = label,
                            selected = themeMode == mode,
                            onClick = {
                                themeMode = mode
                                container.settingsStore.saveThemeMode(mode)
                            },
                        )
                        if (index < modes.lastIndex) {
                            HorizontalDivider(modifier = Modifier.padding(start = 16.dp))
                        }
                    }
                }
            }
            item("update-title") {
                SectionHeader("更新")
            }
            item("update") {
                Card(
                    cornerRadius = 16.dp,
                    insideMargin = PaddingValues(0.dp),
                ) {
                    BasicComponent(
                        title = "当前版本 v${container.updateManager.currentVersionName}",
                        summary = "启动时自动检查更新",
                        endActions = {
                            TextButton(
                                text = "检查更新",
                                onClick = { container.updateManager.check(manual = true) },
                            )
                        },
                    )
                }
            }
        }
    }
}
