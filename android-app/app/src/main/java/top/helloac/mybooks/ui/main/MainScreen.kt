package top.helloac.mybooks.ui.main

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import top.helloac.mybooks.data.AppContainer
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.IconButton
import top.yukonga.miuix.kmp.basic.NavigationBar
import top.yukonga.miuix.kmp.basic.NavigationBarDefaults
import top.yukonga.miuix.kmp.basic.NavigationBarItem
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.SmallTopAppBar
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Add
import top.yukonga.miuix.kmp.icon.extended.Folder
import top.yukonga.miuix.kmp.icon.extended.Months
import top.yukonga.miuix.kmp.icon.extended.Settings
import top.yukonga.miuix.kmp.theme.MiuixTheme

private enum class MainTab(
    val label: String,
    val title: String,
    val icon: ImageVector,
) {
    SHELF("书架", "书架", ShelfBooksIcon),
    RANK("榜单", "榜单", RankBarsIcon),
    STATS("统计", "阅读统计", MiuixIcons.Months),
    TAGS("分类", "标签与分类", MiuixIcons.Folder),
}

@Composable
fun MainScreen(
    container: AppContainer,
    onOpenBook: (Int) -> Unit,
    onAddBook: () -> Unit,
    onSettings: () -> Unit,
) {
    var selectedName by rememberSaveable { mutableStateOf(MainTab.SHELF.name) }
    val selected = MainTab.entries.firstOrNull { it.name == selectedName } ?: MainTab.SHELF
    val stateHolder = rememberSaveableStateHolder()
    var refreshTick by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        container.repository.changes.collect { refreshTick++ }
    }

    Scaffold(
        topBar = {
            if (selected != MainTab.SHELF) {
                SmallTopAppBar(
                    title = selected.title,
                    actions = {
                        if (selected == MainTab.TAGS) {
                            IconButton(onClick = onSettings) {
                                Icon(
                                    imageVector = MiuixIcons.Settings,
                                    contentDescription = "设置",
                                    modifier = Modifier.padding(2.dp),
                                )
                            }
                        }
                    },
                )
            }
        },
        bottomBar = {
            NavigationBar {
                MainTab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = tab == selected,
                        onClick = { selectedName = tab.name },
                        icon = tab.icon,
                        label = tab.label,
                        colors = NavigationBarDefaults.navigationBarItemColors(
                            unselectedContentColor = MiuixTheme.colorScheme.onSurface,
                            selectedContentColor = MiuixTheme.colorScheme.primary,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            stateHolder.SaveableStateProvider(selected.name) {
                when (selected) {
                    MainTab.SHELF -> ShelfTab(
                        container = container,
                        onOpenBook = onOpenBook,
                        refreshTick = refreshTick,
                        onAddBook = onAddBook,
                    )
                    MainTab.RANK -> RankTab(container, onOpenBook, refreshTick)
                    MainTab.STATS -> StatsTab(container, refreshTick)
                    MainTab.TAGS -> CategoriesTab(container, refreshTick)
                }
            }
        }
    }
}
