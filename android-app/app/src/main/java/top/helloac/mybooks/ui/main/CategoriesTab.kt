package top.helloac.mybooks.ui.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.data.Category
import top.helloac.mybooks.data.Series
import top.helloac.mybooks.ui.common.EmptyView
import top.helloac.mybooks.ui.common.ErrorView
import top.helloac.mybooks.ui.common.LoadingView
import top.helloac.mybooks.ui.common.RefreshOnResume
import top.helloac.mybooks.ui.common.TextTabRow
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.HorizontalDivider
import top.yukonga.miuix.kmp.basic.Surface
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.theme.MiuixTheme

private enum class CategoryTab(val label: String) {
    TAGS("标签"),
    AUTHORS("作者"),
    SERIES("系列"),
}

@Composable
fun CategoriesTab(container: AppContainer, refreshTick: Int = 0) {
    var selectedIndex by remember { mutableIntStateOf(0) }
    var tags by remember { mutableStateOf<List<Category>>(emptyList()) }
    var authors by remember { mutableStateOf<List<Category>>(emptyList()) }
    var series by remember { mutableStateOf<List<Series>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }

    RefreshOnResume { reloadKey++ }

    LaunchedEffect(reloadKey, refreshTick) {
        loading = true
        error = null
        runCatching {
            coroutineScope {
                val tagsDeferred = async { container.repository.tags() }
                val authorsDeferred = async { container.repository.authors() }
                val seriesDeferred = async { container.repository.series() }
                Triple(tagsDeferred.await(), authorsDeferred.await(), seriesDeferred.await())
            }
        }.onSuccess { (t, a, s) ->
            tags = t
            authors = a
            series = s
            loading = false
        }.onFailure {
            error = it.message ?: "加载失败"
            loading = false
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        TextTabRow(
            tabs = CategoryTab.entries.map { it.label },
            selectedIndex = selectedIndex,
            onSelected = { selectedIndex = it },
            modifier = Modifier.padding(horizontal = 16.dp),
            fontSize = 15.sp,
            spacing = 28.dp,
        )
        when {
            loading -> LoadingView()
            error != null -> ErrorView(error!!, onRetry = { reloadKey++ })
            else -> {
                when (CategoryTab.entries[selectedIndex]) {
                    CategoryTab.TAGS -> CategoryList(
                        items = tags,
                        emptyText = "还没有标签",
                        countLabel = { "${it.count} 本" },
                    )

                    CategoryTab.AUTHORS -> CategoryList(
                        items = authors,
                        emptyText = "还没有作者",
                        countLabel = { "${it.count} 本" },
                    )

                    CategoryTab.SERIES -> SeriesList(series)
                }
            }
        }
    }
}

@Composable
private fun CategoryList(
    items: List<Category>,
    emptyText: String,
    countLabel: (Category) -> String,
) {
    if (items.isEmpty()) {
        EmptyView(emptyText)
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
    ) {
        item("count") {
            Text(
                text = "共 ${items.size} 项",
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            )
        }
        itemsIndexed(items, key = { _, item -> item.id }) { index, item ->
            BasicComponent(
                title = item.name,
                summary = countLabel(item),
                startAction = { CategoryAvatar(item.name) },
            )
            if (index < items.lastIndex) {
                HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
            }
        }
    }
}

@Composable
private fun SeriesList(items: List<Series>) {
    if (items.isEmpty()) {
        EmptyView("还没有系列")
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
    ) {
        item("count") {
            Text(
                text = "共 ${items.size} 个系列",
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            )
        }
        itemsIndexed(items, key = { _, item -> item.name }) { index, item ->
            BasicComponent(
                title = item.name,
                summary = "${item.count} 本" + if (item.label.isNotBlank()) " · ${item.label}" else "",
                startAction = { CategoryAvatar(item.name) },
            )
            if (index < items.lastIndex) {
                HorizontalDivider(modifier = Modifier.padding(start = 64.dp))
            }
        }
    }
}

@Composable
private fun CategoryAvatar(name: String) {
    Surface(
        modifier = Modifier.size(32.dp),
        shape = CircleShape,
        color = MiuixTheme.colorScheme.secondaryContainer,
        contentColor = MiuixTheme.colorScheme.onSecondaryContainer,
    ) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = name.trim().take(1).ifBlank { "·" },
                color = MiuixTheme.colorScheme.onSecondaryContainer,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}
