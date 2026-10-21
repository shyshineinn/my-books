package top.helloac.mybooks.ui.main

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
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
import top.helloac.mybooks.data.BookStatus
import top.helloac.mybooks.data.BooksRepository
import top.helloac.mybooks.data.Stats
import top.helloac.mybooks.ui.common.BookCover
import top.helloac.mybooks.ui.common.ErrorView
import top.helloac.mybooks.ui.common.LoadingView
import top.helloac.mybooks.ui.common.RefreshOnResume
import top.helloac.mybooks.ui.common.SectionHeader
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.theme.MiuixTheme

@Composable
fun HomeTab(
    container: AppContainer,
    onOpenBook: (Int) -> Unit,
    refreshTick: Int = 0,
) {
    val repo = container.repository
    var stats by remember { mutableStateOf<Stats?>(null) }
    var recent by remember { mutableStateOf<List<Book>>(emptyList()) }
    var reading by remember { mutableStateOf<List<Book>>(emptyList()) }
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
                val recentDeferred = async { repo.listBooks(sort = BooksRepository.SORT_CREATED) }
                val readingDeferred = async { repo.listBooks(status = BookStatus.READING, sort = BooksRepository.SORT_UPDATED) }
                Triple(statsDeferred.await(), recentDeferred.await(), readingDeferred.await())
            }
        }.onSuccess { (s, r, readingBooks) ->
            stats = s
            recent = r.take(12)
            reading = readingBooks.take(12)
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
                contentPadding = PaddingValues(bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                item("hero") {
                    HeroCard(current)
                }
                if (reading.isNotEmpty()) {
                    item("reading") {
                        Column {
                            SectionHeader(
                                title = "继续阅读",
                                modifier = Modifier.padding(horizontal = 16.dp),
                            )
                            Spacer(Modifier.height(10.dp))
                            LazyRow(
                                contentPadding = PaddingValues(horizontal = 16.dp),
                                horizontalArrangement = Arrangement.spacedBy(14.dp),
                            ) {
                                items(reading, key = { it.id }) { book ->
                                    HomeBookCard(book, repo.coverUrl(book.cover), onOpenBook)
                                }
                            }
                        }
                    }
                }
                item("recent") {
                    Column {
                        SectionHeader(
                            title = "最新上架",
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                        Spacer(Modifier.height(10.dp))
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            items(recent, key = { it.id }) { book ->
                                HomeBookCard(book, repo.coverUrl(book.cover), onOpenBook)
                            }
                        }
                    }
                }
                item("tags") {
                    if (current.topTags.isNotEmpty()) {
                        Column {
                            SectionHeader(
                                title = "常用标签",
                                modifier = Modifier.padding(horizontal = 16.dp),
                            )
                            Spacer(Modifier.height(10.dp))
                            LazyRow(
                                contentPadding = PaddingValues(horizontal = 16.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                items(current.topTags) { tag ->
                                    Card(
                                        cornerRadius = 14.dp,
                                        insideMargin = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                                    ) {
                                        Text(
                                            text = "${tag.name} · ${tag.count}",
                                            style = MiuixTheme.textStyles.body2,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun HeroCard(stats: Stats) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        cornerRadius = 22.dp,
        insideMargin = PaddingValues(20.dp),
    ) {
        Column {
            Text(
                text = "阅读概览",
                style = MiuixTheme.textStyles.title2,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(16.dp))
            Row(modifier = Modifier.fillMaxWidth()) {
                StatBlock("总藏书", stats.total, Modifier.weight(1f))
                StatBlock("已读", stats.done, Modifier.weight(1f))
                StatBlock("在读", stats.reading, Modifier.weight(1f))
                StatBlock("想读", stats.wish, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun StatBlock(label: String, value: Int, modifier: Modifier = Modifier) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = value.toString(),
            style = MiuixTheme.textStyles.title2,
            fontWeight = FontWeight.SemiBold,
            color = MiuixTheme.colorScheme.primary,
        )
        Text(
            text = label,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun HomeBookCard(
    book: Book,
    coverUrl: String?,
    onOpenBook: (Int) -> Unit,
) {
    Column(
        modifier = Modifier
            .width(104.dp)
            .clickable { onOpenBook(book.id) },
    ) {
        BookCover(
            book = book,
            coverUrl = coverUrl,
            modifier = Modifier
                .width(104.dp)
                .aspectRatio(0.68f),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = book.title,
            style = MiuixTheme.textStyles.body2,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = book.author ?: "未知作者",
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
