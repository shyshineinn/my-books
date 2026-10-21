package top.helloac.mybooks.ui.main

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpSize
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
import top.helloac.mybooks.ui.common.RefreshOnResume
import top.yukonga.miuix.kmp.basic.DropdownEntry
import top.yukonga.miuix.kmp.basic.DropdownItem
import top.yukonga.miuix.kmp.basic.FloatingToolbar
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.IconButton
import top.yukonga.miuix.kmp.basic.InputField
import top.yukonga.miuix.kmp.basic.SearchBar
import top.yukonga.miuix.kmp.basic.Surface
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Add
import top.yukonga.miuix.kmp.icon.extended.Tune
import top.yukonga.miuix.kmp.menu.OverlayIconCascadingDropdownMenu
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
    onAddBook: () -> Unit,
) {
    val repo = container.repository
    var query by rememberSaveable { mutableStateOf("") }
    var searchExpanded by rememberSaveable { mutableStateOf(false) }
    var statusIndex by rememberSaveable { mutableIntStateOf(0) }
    var sortIndex by rememberSaveable { mutableIntStateOf(0) }
    var books by remember { mutableStateOf<List<Book>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }
    val filterEntries = remember(statusIndex, sortIndex) {
        listOf(
            DropdownEntry(
                items = listOf(
                    DropdownItem(
                        text = "阅读状态",
                        summary = statusFilters[statusIndex].second,
                        children = statusFilters.mapIndexed { index, (_, label) ->
                            DropdownItem(
                                text = label,
                                selected = index == statusIndex,
                                onClick = { statusIndex = index },
                            )
                        },
                    ),
                ),
            ),
            DropdownEntry(
                items = listOf(
                    DropdownItem(
                        text = "排序",
                        summary = BooksRepository.sortOptions[sortIndex].second,
                        children = BooksRepository.sortOptions.mapIndexed { index, (_, label) ->
                            DropdownItem(
                                text = label,
                                selected = index == sortIndex,
                                onClick = { sortIndex = index },
                            )
                        },
                    ),
                ),
            ),
        )
    }

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

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.padding(horizontal = 16.dp)) {
            Spacer(modifier = Modifier.height(8.dp))
            SearchBar(
                inputField = {
                    InputField(
                        query = query,
                        onQueryChange = { query = it },
                        onSearch = { searchExpanded = false },
                        expanded = searchExpanded,
                        onExpandedChange = { searchExpanded = it },
                        label = "搜索书名、作者",
                    )
                },
                onExpandedChange = { searchExpanded = it },
                modifier = Modifier.fillMaxWidth(),
                insideMargin = DpSize(0.dp, 0.dp),
                expanded = searchExpanded,
                outsideEndAction = {
                    TextButton(
                        text = "取消",
                        onClick = {
                            searchExpanded = false
                            query = ""
                        },
                        cornerRadius = 12.dp,
                        minWidth = 48.dp,
                        minHeight = 32.dp,
                        insideMargin = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                    )
                },
                content = {},
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "书架",
                    style = MiuixTheme.textStyles.title2,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (loading && books.isEmpty()) "加载中…" else "共 ${books.size} 本",
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 12.sp,
                )
                Spacer(Modifier.weight(1f))
                OverlayIconCascadingDropdownMenu(
                    entries = filterEntries,
                    minWidth = 36.dp,
                    minHeight = 36.dp,
                    cornerRadius = 18.dp,
                ) {
                    Icon(
                        imageVector = MiuixIcons.Tune,
                        contentDescription = "筛选",
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }

        when {
            loading && books.isEmpty() -> LoadingView()
            error != null && books.isEmpty() -> ErrorView(error!!, onRetry = { reloadKey++ })
            books.isEmpty() -> EmptyView("没有找到符合条件的书")
            else -> LazyVerticalGrid(
                columns = GridCells.Fixed(3),
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 96.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
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
        FloatingToolbar(
            modifier = Modifier.align(Alignment.BottomEnd),
            outSidePadding = PaddingValues(12.dp),
        ) {
            IconButton(
                onClick = onAddBook,
                minWidth = 56.dp,
                minHeight = 56.dp,
                cornerRadius = 28.dp,
            ) {
                Icon(
                    imageVector = MiuixIcons.Add,
                    contentDescription = "添加书籍",
                    tint = MiuixTheme.colorScheme.primary,
                    modifier = Modifier.size(26.dp),
                )
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
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        color = Color.Transparent,
    ) {
        Column {
            Box {
                BookCover(
                    book = book,
                    coverUrl = coverUrl,
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(0.68f),
                    cornerRadius = 6.dp,
                )
                when (book.status) {
                    BookStatus.DONE -> ShelfBadge(
                        text = "读完",
                        background = MiuixTheme.colorScheme.tertiaryContainer,
                        content = MiuixTheme.colorScheme.onTertiaryContainer,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(6.dp),
                    )

                    BookStatus.READING -> ShelfBadge(
                        text = "在读",
                        background = MiuixTheme.colorScheme.primary,
                        content = MiuixTheme.colorScheme.onPrimary,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(6.dp),
                    )

                    BookStatus.WISH -> Unit
                }
            }
            Text(
                text = book.title,
                style = MiuixTheme.textStyles.body2,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun ShelfBadge(
    text: String,
    background: Color,
    content: Color,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(4.dp),
        color = background,
        contentColor = content,
    ) {
        Text(
            text = text,
            color = content,
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp),
        )
    }
}
