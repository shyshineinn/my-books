package top.helloac.mybooks.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.data.Book
import top.helloac.mybooks.data.BookStatus
import top.helloac.mybooks.data.BooksRepository
import top.helloac.mybooks.ui.common.BookCover
import top.helloac.mybooks.ui.common.EmptyView
import top.helloac.mybooks.ui.common.ErrorView
import top.helloac.mybooks.ui.common.LoadingView
import top.helloac.mybooks.ui.common.RatingBadge
import top.helloac.mybooks.ui.common.RefreshOnResume
import top.helloac.mybooks.ui.common.StatusPill
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.TabRow
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.basic.Search
import top.yukonga.miuix.kmp.theme.MiuixTheme

private val statusFilters = listOf(
    null to "全部",
    BookStatus.WISH to "想读",
    BookStatus.READING to "在读",
    BookStatus.DONE to "已读",
)

@Composable
fun ShelfTab(
    container: AppContainer,
    onOpenBook: (Int) -> Unit,
    refreshTick: Int = 0,
) {
    val repo = container.repository
    var query by rememberSaveable { mutableStateOf("") }
    var statusIndex by rememberSaveable { mutableIntStateOf(0) }
    var sortIndex by rememberSaveable { mutableIntStateOf(0) }
    var books by remember { mutableStateOf<List<Book>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }

    RefreshOnResume { reloadKey++ }

    LaunchedEffect(query, statusIndex, sortIndex, reloadKey, refreshTick) {
        if (query.isNotBlank()) delay(300)
        loading = true
        error = null
        runCatching {
            repo.listBooks(
                query = query,
                status = statusFilters[statusIndex].first,
                sort = BooksRepository.sortOptions[sortIndex].first,
            )
        }.onSuccess {
            books = it
            loading = false
        }.onFailure {
            error = it.message ?: "加载失败"
            loading = false
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.padding(horizontal = 16.dp)) {
            TextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth(),
                label = "搜索书名、作者或高级语法",
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                leadingIcon = {
                    Icon(
                        imageVector = MiuixIcons.Basic.Search,
                        contentDescription = null,
                        modifier = Modifier.padding(start = 12.dp, end = 8.dp),
                    )
                },
            )
            Spacer(Modifier.height(10.dp))
            TabRow(
                tabs = statusFilters.map { it.second },
                selectedTabIndex = statusIndex,
                onTabSelected = { statusIndex = it },
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    text = "排序",
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(end = 2.dp),
                )
                BooksRepository.sortOptions.forEachIndexed { index, (_, label) ->
                    val selected = index == sortIndex
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(
                                if (selected) {
                                    MiuixTheme.colorScheme.primary.copy(alpha = 0.12f)
                                } else {
                                    Color.Transparent
                                },
                            )
                            .clickable { sortIndex = index }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    ) {
                        Text(
                            text = label,
                            color = if (selected) {
                                MiuixTheme.colorScheme.primary
                            } else {
                                MiuixTheme.colorScheme.onSurfaceVariantSummary
                            },
                            fontSize = 12.sp,
                            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
                        )
                    }
                }
            }
            Text(
                text = if (loading && books.isEmpty()) "加载中…" else "共 ${books.size} 本",
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                fontSize = 12.sp,
                modifier = Modifier.padding(bottom = 4.dp),
            )
        }

        when {
            loading && books.isEmpty() -> LoadingView()
            error != null && books.isEmpty() -> ErrorView(error!!, onRetry = { reloadKey++ })
            books.isEmpty() -> EmptyView("没有找到符合条件的书")
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 148.dp),
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                items(books, key = { it.id }) { book ->
                    ShelfGridItem(
                        book = book,
                        coverUrl = repo.coverUrl(book.cover),
                        onClick = { onOpenBook(book.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ShelfGridItem(
    book: Book,
    coverUrl: String?,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        BookCover(
            book = book,
            coverUrl = coverUrl,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(0.68f),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = book.title,
            style = MiuixTheme.textStyles.body1,
            fontWeight = FontWeight.Medium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = book.author ?: "未知作者",
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(5.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            StatusPill(book.status)
            RatingBadge(book.rating)
        }
    }
}
