package top.helloac.mybooks.ui.book

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.data.Book
import top.helloac.mybooks.data.BookFile
import top.helloac.mybooks.data.Identifier
import top.helloac.mybooks.data.ReadLog
import top.helloac.mybooks.ui.common.BookCover
import top.helloac.mybooks.ui.common.ErrorView
import top.helloac.mybooks.ui.common.LoadingView
import top.helloac.mybooks.ui.common.RatingBadge
import top.helloac.mybooks.ui.common.RefreshOnResume
import top.helloac.mybooks.ui.common.SectionHeader
import top.helloac.mybooks.ui.common.StatusPill
import top.helloac.mybooks.ui.common.formatRating
import java.util.Locale
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
import top.yukonga.miuix.kmp.basic.Surface
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.extended.Back
import top.yukonga.miuix.kmp.icon.extended.Delete
import top.yukonga.miuix.kmp.icon.extended.Edit
import top.yukonga.miuix.kmp.overlay.OverlayDialog
import top.yukonga.miuix.kmp.preference.ArrowPreference
import top.yukonga.miuix.kmp.theme.MiuixTheme

@Composable
fun BookDetailScreen(
    container: AppContainer,
    bookId: Int,
    onBack: () -> Unit,
    onEdit: () -> Unit,
) {
    val repo = container.repository
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var book by remember(bookId) { mutableStateOf<Book?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }
    var showDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }

    RefreshOnResume { reloadKey++ }

    LaunchedEffect(bookId, reloadKey) {
        if (book == null) loading = true
        error = null
        runCatching { repo.getBook(bookId) }
            .onSuccess {
                book = it
                loading = false
            }
            .onFailure {
                error = it.message ?: "加载失败"
                loading = false
            }
    }

    Scaffold(
        topBar = {
            SmallTopAppBar(
                title = "书籍详情",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(imageVector = MiuixIcons.Back, contentDescription = "返回")
                    }
                },
                actions = {
                    if (book != null) {
                        IconButton(onClick = onEdit) {
                            Icon(imageVector = MiuixIcons.Edit, contentDescription = "编辑")
                        }
                        IconButton(onClick = { showDelete = true }) {
                            Icon(imageVector = MiuixIcons.Delete, contentDescription = "删除")
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        val current = book
        when {
            loading && current == null -> LoadingView(Modifier.padding(padding))
            error != null && current == null -> ErrorView(
                message = error!!,
                onRetry = { reloadKey++ },
                modifier = Modifier.padding(padding),
            )

            current != null -> {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentPadding = PaddingValues(bottom = 36.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    item("header") {
                        BookHeader(
                            book = current,
                            coverUrl = repo.coverUrl(current.cover),
                            onOpenBookCover = {
                                repo.coverUrl(current.cover)?.let { openUrl(context, it) }
                            },
                        )
                    }
                    item("meta") {
                        BookMetaCard(current)
                    }
                    if (current.tags.isNotEmpty()) {
                        item("tags") {
                            Column(modifier = Modifier.padding(horizontal = 16.dp)) {
                                SectionHeader("标签")
                                Spacer(Modifier.height(8.dp))
                                TagFlow(current.tags)
                            }
                        }
                    }
                    if (current.summary != null) {
                        item("summary") {
                            Column(modifier = Modifier.padding(horizontal = 16.dp)) {
                                SectionHeader("简介")
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    text = current.summary,
                                    style = MiuixTheme.textStyles.body1,
                                    color = MiuixTheme.colorScheme.onSurface,
                                )
                            }
                        }
                    }
                    if (current.readLogs.isNotEmpty()) {
                        item("logs-title") {
                            SectionHeader("阅读记录", modifier = Modifier.padding(horizontal = 16.dp))
                        }
                        itemsIndexed(current.readLogs) { index, log ->
                            ReadLogRow(index + 1, log)
                        }
                    }
                    if (current.customDisplay.isNotEmpty()) {
                        item("custom-title") {
                            SectionHeader("自定义字段", modifier = Modifier.padding(horizontal = 16.dp))
                        }
                        item("custom-values") {
                            Card(
                                modifier = Modifier.padding(horizontal = 16.dp),
                                cornerRadius = 18.dp,
                                insideMargin = PaddingValues(16.dp),
                            ) {
                                current.customDisplay.entries
                                    .filter { it.value.isNotBlank() }
                                    .forEach { (key, value) ->
                                        InfoRow(key, value)
                                    }
                            }
                        }
                    }
                    if (current.identifiers.isNotEmpty()) {
                        item("ids-title") {
                            SectionHeader("标识符", modifier = Modifier.padding(horizontal = 16.dp))
                        }
                        item("ids") {
                            Card(
                                modifier = Modifier.padding(horizontal = 16.dp),
                                cornerRadius = 18.dp,
                                insideMargin = PaddingValues(16.dp),
                            ) {
                                current.identifiers.forEach { identifier ->
                                    IdentifierRow(identifier) { url ->
                                        openUrl(context, url)
                                    }
                                }
                            }
                        }
                    }
                    if (current.notesUrl != null) {
                        item("notes") {
                            Card(
                                modifier = Modifier.padding(horizontal = 16.dp),
                                cornerRadius = 18.dp,
                                insideMargin = PaddingValues(0.dp),
                            ) {
                                ArrowPreference(
                                    title = "读书心得",
                                    summary = "打开链接",
                                    onClick = {
                                        repo.absoluteUrl(current.notesUrl)?.let { openUrl(context, it) }
                                    },
                                )
                            }
                        }
                    }
                    if (current.files.isNotEmpty()) {
                        item("files-title") {
                            SectionHeader("电子书文件", modifier = Modifier.padding(horizontal = 16.dp))
                        }
                        item("files") {
                            Card(
                                modifier = Modifier.padding(horizontal = 16.dp),
                                cornerRadius = 18.dp,
                                insideMargin = PaddingValues(0.dp),
                            ) {
                                current.files.forEachIndexed { index, file ->
                                    FileRow(file) {
                                        repo.absoluteUrl("/books-files/${file.path}")?.let {
                                            openUrl(context, it)
                                        }
                                    }
                                    if (index < current.files.lastIndex) {
                                        HorizontalDivider(modifier = Modifier.padding(start = 16.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        OverlayDialog(
            show = showDelete,
            title = "移入回收站？",
            summary = "删除后 14 天内可以在分类页的回收站中恢复。",
            onDismissRequest = { if (!deleting) showDelete = false },
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                TextButton(
                    text = "取消",
                    onClick = { showDelete = false },
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        deleting = true
                        scope.launch {
                            runCatching { repo.deleteBook(bookId) }
                                .onSuccess {
                                    deleting = false
                                    showDelete = false
                                    onBack()
                                }
                                .onFailure {
                                    deleting = false
                                    showDelete = false
                                    val text = it.message ?: "删除失败"
                                    scope.launch { snackbarHostState.showSnackbar(text) }
                                }
                        }
                    },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(
                        color = MiuixTheme.colorScheme.error,
                        contentColor = MiuixTheme.colorScheme.onError,
                    ),
                ) {
                    Text(if (deleting) "删除中…" else "移入回收站")
                }
            }
        }

    }
}

@Composable
private fun BookHeader(
    book: Book,
    coverUrl: String?,
    onOpenBookCover: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Surface(
            onClick = onOpenBookCover,
            modifier = Modifier
                .width(116.dp)
                .height(170.dp),
            shape = RoundedCornerShape(12.dp),
            color = Color.Transparent,
        ) {
            BookCover(
                book = book,
                coverUrl = coverUrl,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Spacer(Modifier.size(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = book.title,
                style = MiuixTheme.textStyles.title2,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = book.author ?: "未知作者",
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                style = MiuixTheme.textStyles.body2,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(10.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                StatusPill(book.status)
                RatingBadge(book.rating)
            }
            if (book.seriesLabel != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = book.seriesLabel,
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 12.sp,
                )
            }
            if (book.readCount > 0) {
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "读过 ${book.readCount} 次",
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 12.sp,
                )
            }
        }
    }
}

@Composable
private fun BookMetaCard(
    book: Book,
) {
    Card(
        modifier = Modifier.padding(horizontal = 16.dp),
        cornerRadius = 18.dp,
        insideMargin = PaddingValues(16.dp),
    ) {
        if (book.publisher != null) InfoRow("出版社", book.publisher)
        if (book.pubYear != null) InfoRow("出版年", book.pubYear)
        if (book.isbn != null) InfoRow("ISBN", book.isbn)
        if (book.rating != null) InfoRow("评分", "${formatRating(book.rating)} / 10")
        if (book.startDate != null) InfoRow("开始日期", book.startDate)
        if (book.finishDate != null) InfoRow("读完日期", book.finishDate)
        if (book.createdAt != null) InfoRow("加入时间", book.createdAt.take(10))
    }
}

@Composable
private fun InfoRow(
    label: String,
    value: String,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = label,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            fontSize = 13.sp,
            modifier = Modifier.width(76.dp),
        )
        Text(
            text = value,
            color = MiuixTheme.colorScheme.onSurface,
            fontSize = 13.sp,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun IdentifierRow(identifier: Identifier, onOpen: (String) -> Unit) {
    val target = identifier.url
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = identifier.label,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            fontSize = 13.sp,
            modifier = Modifier.width(86.dp),
        )
        if (target != null) {
            Surface(
                onClick = { onOpen(target) },
                modifier = Modifier.weight(1f),
                color = Color.Transparent,
            ) {
                Text(
                    text = identifier.value,
                    color = MiuixTheme.colorScheme.primary,
                    fontSize = 13.sp,
                )
            }
        } else {
            Text(
                text = identifier.value,
                color = MiuixTheme.colorScheme.onSurface,
                fontSize = 13.sp,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun ReadLogRow(index: Int, log: ReadLog) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        cornerRadius = 14.dp,
        insideMargin = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "第 $index 次",
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                fontSize = 12.sp,
                modifier = Modifier.width(58.dp),
            )
            Text(
                text = log.label,
                style = MiuixTheme.textStyles.body2,
            )
        }
    }
}

@Composable
private fun FileRow(file: BookFile, onDownload: () -> Unit) {
    BasicComponent(
        title = file.format,
        summary = formatSize(file.size),
        endActions = {
            TextButton(text = "下载", onClick = onDownload)
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TagFlow(tags: List<String>) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        tags.forEach { tag ->
            Surface(
                shape = CircleShape,
                color = MiuixTheme.colorScheme.secondaryContainer,
                contentColor = MiuixTheme.colorScheme.onSecondaryContainer,
            ) {
                Text(
                    text = tag,
                    color = MiuixTheme.colorScheme.onSecondaryContainer,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                )
            }
        }
    }
}

private fun formatSize(bytes: Long): String = when {
    bytes >= 1024L * 1024 * 1024 -> String.format(Locale.US, "%.1f GB", bytes / (1024.0 * 1024 * 1024))
    bytes >= 1024L * 1024 -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024))
    bytes >= 1024L -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
    else -> "$bytes B"
}

private fun openUrl(context: Context, url: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }
}
