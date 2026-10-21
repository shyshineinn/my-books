package top.helloac.mybooks.ui.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import top.helloac.mybooks.data.UpdateManager
import top.helloac.mybooks.data.UpdateState
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.LinearProgressIndicator
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.window.WindowDialog
import java.util.Locale

@Composable
fun UpdateHost(manager: UpdateManager) {
    val state by manager.state.collectAsState()
    val current = state
    val force = when (current) {
        is UpdateState.Available -> current.force
        is UpdateState.Downloading -> current.force
        is UpdateState.Ready -> current.force
        is UpdateState.Failed -> current.force
        else -> false
    }
    val visible = when (current) {
        UpdateState.Idle -> false
        is UpdateState.Checking -> current.manual
        else -> true
    }
    val title = when (current) {
        is UpdateState.Available -> "发现新版本 v${current.manifest.versionName}"
        is UpdateState.Downloading -> "正在下载更新"
        is UpdateState.Ready -> "下载完成"
        is UpdateState.Failed -> "更新失败"
        is UpdateState.UpToDate -> "已是最新版本"
        is UpdateState.Checking -> "检查更新"
        UpdateState.Idle -> ""
    }
    val summary = when (current) {
        is UpdateState.Available ->
            "当前版本 v${manager.currentVersionName} · 安装包 ${formatSize(current.manifest.size)}"

        is UpdateState.Downloading ->
            "v${current.manifest.versionName} · ${(current.progress * 100).toInt()}%"

        is UpdateState.Ready -> "v${current.manifest.versionName} · 安装包已下载并通过校验"
        is UpdateState.Failed -> current.message
        is UpdateState.UpToDate -> "当前版本 v${manager.currentVersionName}"
        is UpdateState.Checking -> "正在连接更新服务器…"
        UpdateState.Idle -> ""
    }

    WindowDialog(
        show = visible,
        title = title,
        summary = summary,
        onDismissRequest = if (force || current is UpdateState.Downloading || current is UpdateState.Checking) {
            null
        } else {
            { manager.dismiss() }
        },
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            when (current) {
                UpdateState.Idle -> Unit
                is UpdateState.Checking -> CheckingContent()
                is UpdateState.Available -> AvailableContent(current.manifest.changelog, force, manager)
                is UpdateState.Downloading -> DownloadingContent(current.progress, force, manager)
                is UpdateState.Ready -> ReadyContent(force, manager)
                is UpdateState.Failed -> FailedContent(
                    hasManifest = current.manifest != null,
                    hasFile = current.file != null,
                    force = force,
                    manager = manager,
                )

                is UpdateState.UpToDate -> FullWidthButton("知道了") { manager.dismiss() }
            }
        }
    }
}

@Composable
private fun CheckingContent() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CircularProgressIndicator(size = 22.dp)
        Text(
            text = "正在检查更新…",
            style = MiuixTheme.textStyles.body2,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
        )
    }
}

@Composable
private fun AvailableContent(
    changelog: List<String>,
    force: Boolean,
    manager: UpdateManager,
) {
    if (changelog.isNotEmpty()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 220.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = "更新内容",
                style = MiuixTheme.textStyles.body1,
                fontWeight = FontWeight.Medium,
            )
            changelog.forEach { line ->
                Text(
                    text = "• $line",
                    style = MiuixTheme.textStyles.body2,
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                )
            }
        }
        Spacer(Modifier.height(18.dp))
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (!force) {
            TextButton(
                text = "稍后",
                onClick = { manager.dismiss() },
                modifier = Modifier.weight(1f),
            )
        }
        PrimaryButton(
            text = "立即更新",
            modifier = Modifier.weight(1f),
            onClick = { manager.download() },
        )
    }
}

@Composable
private fun DownloadingContent(
    progress: Float,
    force: Boolean,
    manager: UpdateManager,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        LinearProgressIndicator(
            progress = progress.coerceIn(0f, 1f),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(10.dp))
        Text(
            text = "${(progress * 100).toInt()}%",
            style = MiuixTheme.textStyles.body2,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
        )
        if (!force) {
            Spacer(Modifier.height(12.dp))
            TextButton(
                text = "取消下载",
                onClick = { manager.cancelDownload() },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ReadyContent(force: Boolean, manager: UpdateManager) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (!force) {
            TextButton(
                text = "稍后",
                onClick = { manager.dismiss() },
                modifier = Modifier.weight(1f),
            )
        }
        PrimaryButton(
            text = "安装",
            modifier = Modifier.weight(1f),
            onClick = { manager.install() },
        )
    }
}

@Composable
private fun FailedContent(
    hasManifest: Boolean,
    hasFile: Boolean,
    force: Boolean,
    manager: UpdateManager,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (!force) {
            TextButton(
                text = "关闭",
                onClick = { manager.dismiss() },
                modifier = Modifier.weight(1f),
            )
        }
        if (hasManifest) {
            PrimaryButton(
                text = if (hasFile) "重新安装" else "重试",
                modifier = Modifier.weight(1f),
                onClick = { manager.retry() },
            )
        }
    }
}

@Composable
private fun PrimaryButton(
    text: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        colors = ButtonDefaults.buttonColors(
            color = MiuixTheme.colorScheme.primary,
            contentColor = MiuixTheme.colorScheme.onPrimary,
        ),
    ) {
        Text(text)
    }
}

@Composable
private fun FullWidthButton(text: String, onClick: () -> Unit) {
    PrimaryButton(
        text = text,
        modifier = Modifier.fillMaxWidth(),
        onClick = onClick,
    )
}

private fun formatSize(bytes: Long): String = when {
    bytes >= 1024L * 1024 -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024))
    bytes >= 1024L -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
    else -> "$bytes B"
}
