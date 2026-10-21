package top.helloac.mybooks.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.ui.common.MetaText
import top.helloac.mybooks.ui.common.SectionHeader
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.IconButton
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.SmallTopAppBar
import top.yukonga.miuix.kmp.basic.TabRow
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Back
import top.yukonga.miuix.kmp.theme.MiuixTheme

@Composable
fun SettingsScreen(
    container: AppContainer,
    onBack: () -> Unit,
) {
    val settings = container.settingsStore.settings
    var baseUrl by remember { mutableStateOf(settings.value.baseUrl) }
    var themeMode by remember { mutableIntStateOf(settings.value.themeMode) }
    var message by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        runCatching { container.repository.serverSettings() }
            .onSuccess { if (!it.notesRepo.isNullOrBlank()) message = "心得仓库：${it.notesRepo}" }
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
            item("actions") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = {
                            container.settingsStore.save(
                                settings.value.copy(baseUrl = baseUrl),
                            )
                            baseUrl = container.settingsStore.settings.value.baseUrl
                            message = "已保存"
                        },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(
                            color = MiuixTheme.colorScheme.primary,
                            contentColor = MiuixTheme.colorScheme.onPrimary,
                        ),
                    ) {
                        Text("保存")
                    }
                    TextButton(
                        text = if (testing) "测试中…" else "测试连接",
                        onClick = {
                            if (testing) return@TextButton
                            testing = true
                            message = null
                            scope.launch {
                                runCatching { container.repository.stats() }
                                    .onSuccess { message = "连接成功：${it.total} 本藏书" }
                                    .onFailure { message = it.message ?: "连接失败" }
                                testing = false
                            }
                        },
                    )
                }
            }
            if (message != null) {
                item("message") {
                    Text(
                        text = message!!,
                        color = MiuixTheme.colorScheme.primary,
                        fontSize = 13.sp,
                    )
                }
            }
            item("theme-title") {
                SectionHeader("外观")
            }
            item("theme") {
                TabRow(
                    tabs = listOf("跟随系统", "浅色", "深色"),
                    selectedTabIndex = themeMode,
                    onTabSelected = {
                        themeMode = it
                        container.settingsStore.saveThemeMode(it)
                    },
                )
            }
            item("update-title") {
                SectionHeader("更新")
            }
            item("update") {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "当前版本 v${container.updateManager.currentVersionName}",
                            style = MiuixTheme.textStyles.body1,
                        )
                        MetaText("启动时自动检查更新，12 小时内最多一次")
                    }
                    TextButton(
                        text = "检查更新",
                        onClick = { container.updateManager.check(manual = true) },
                    )
                }
            }
        }
    }
}
