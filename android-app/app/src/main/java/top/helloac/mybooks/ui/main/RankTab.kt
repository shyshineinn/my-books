package top.helloac.mybooks.ui.main

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.data.Book
import top.helloac.mybooks.data.BooksRepository
import top.helloac.mybooks.data.Stats
import top.helloac.mybooks.ui.common.BookCover
import top.helloac.mybooks.ui.common.EmptyView
import top.helloac.mybooks.ui.common.ErrorView
import top.helloac.mybooks.ui.common.LoadingView
import top.helloac.mybooks.ui.common.RefreshOnResume
import top.helloac.mybooks.ui.common.SectionHeader
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.theme.MiuixTheme

@Composable
fun RankTab(
    container: AppContainer,
    onOpenBook: (Int) -> Unit,
    refreshTick: Int = 0,
) {
    val repo = container.repository
    var stats by remember { mutableStateOf<Stats?>(null) }
    var books by remember { mutableStateOf<List<Book>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }

    RefreshOnResume { reloadKey++ }

    LaunchedEffect(reloadKey, refreshTick) {
        loading = true
        error = null
        runCatching {
            coroutineScope {
                val statsDeferred = async { repo.stats() }
                val booksDeferred = async { repo.listBooks(sort = BooksRepository.SORT_FINISH) }
                statsDeferred.await() to booksDeferred.await()
            }
        }.onSuccess { (s, all) ->
            stats = s
            books = all.filter { it.readCount >= 2 }.sortedByDescending { it.readCount }.take(8)
            loading = false
        }.onFailure {
            error = it.message ?: "加载失败"
            loading = false
        }
    }

    when {
        loading && stats == null -> LoadingView()
        error != null && stats == null -> ErrorView(error!!, onRetry = { reloadKey++ })
        else -> {
            val current = stats ?: return
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item("hero") {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        cornerRadius = 22.dp,
                        insideMargin = PaddingValues(20.dp),
                    ) {
                        Row(modifier = Modifier.fillMaxWidth()) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = current.total.toString(),
                                    style = MiuixTheme.textStyles.title1,
                                    fontWeight = FontWeight.Bold,
                                )
                                Text(
                                    text = "总藏书",
                                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                                    fontSize = 12.sp,
                                )
                            }
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = current.done.toString(),
                                    style = MiuixTheme.textStyles.title1,
                                    fontWeight = FontWeight.Bold,
                                    color = MiuixTheme.colorScheme.primary,
                                )
                                Text(
                                    text = "读完",
                                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                                    fontSize = 12.sp,
                                )
                            }
                        }
                    }
                }
                item("title") {
                    SectionHeader(
                        title = "重读榜",
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                if (books.isEmpty()) {
                    item("empty") { EmptyView("还没有重读过的书") }
                } else {
                    itemsIndexed(books, key = { _, book -> book.id }) { index, book ->
                        RereadRow(index + 1, book, repo.coverUrl(book.cover), onOpenBook)
                    }
                }
            }
        }
    }
}

@Composable
private fun RereadRow(
    rank: Int,
    book: Book,
    coverUrl: String?,
    onOpenBook: (Int) -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpenBook(book.id) },
        cornerRadius = 16.dp,
        insideMargin = PaddingValues(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = rank.toString(),
                style = MiuixTheme.textStyles.title3,
                fontWeight = FontWeight.Bold,
                color = if (rank <= 3) MiuixTheme.colorScheme.primary else MiuixTheme.colorScheme.onSurfaceVariantSummary,
                modifier = Modifier.padding(end = 12.dp),
            )
            BookCover(
                book = book,
                coverUrl = coverUrl,
                modifier = Modifier.size(width = 44.dp, height = 62.dp),
                cornerRadius = 8.dp,
            )
            Spacer(Modifier.size(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = book.title,
                    style = MiuixTheme.textStyles.body1,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = book.author ?: "未知作者",
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = "读过 ${book.readCount} 次",
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                fontSize = 12.sp,
            )
        }
    }
}
