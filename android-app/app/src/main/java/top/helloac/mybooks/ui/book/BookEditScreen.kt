package top.helloac.mybooks.ui.book

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.data.BookDraft
import top.helloac.mybooks.data.BookStatus
import top.helloac.mybooks.data.BooksRepository
import top.helloac.mybooks.data.ReadLog
import top.helloac.mybooks.ui.common.CoverImage
import top.helloac.mybooks.ui.common.ErrorView
import top.helloac.mybooks.ui.common.LoadingView
import top.helloac.mybooks.ui.common.MetaText
import top.helloac.mybooks.ui.common.SectionHeader
import top.helloac.mybooks.ui.common.formatRating
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.basic.IconButton
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.SmallTopAppBar
import top.yukonga.miuix.kmp.basic.TabRow
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.basic.Close
import top.yukonga.miuix.kmp.icon.extended.Back
import top.yukonga.miuix.kmp.theme.MiuixTheme

private class EditState(initial: BookDraft) {
    var title by mutableStateOf(initial.title)
    var author by mutableStateOf(initial.author)
    var status by mutableStateOf(initial.status)
    var summary by mutableStateOf(initial.summary)
    var tagsText by mutableStateOf(initial.tags.joinToString("、"))
    var cover by mutableStateOf(initial.cover)
    var notesUrl by mutableStateOf(initial.notesUrl)
    var publisher by mutableStateOf(initial.publisher)
    var pubYear by mutableStateOf(initial.pubYear)
    var isbn by mutableStateOf(initial.isbn)
    var ratingText by mutableStateOf(initial.rating?.let { formatRating(it) } ?: "")
    var series by mutableStateOf(initial.series)
    var seriesIndexText by mutableStateOf(initial.seriesIndex?.let { formatRating(it) } ?: "")
    val readLogs = mutableStateListOf<ReadLog>().apply { addAll(initial.readLogs) }

    fun selectStatus(next: BookStatus) {
        if (next == status) return
        status = next
        val today = BooksRepository.today()
        when (next) {
            BookStatus.DONE -> {
                if (readLogs.none { it.finish.isNotBlank() }) {
                    readLogs.add(ReadLog(start = "", finish = today))
                }
            }

            BookStatus.READING -> {
                if (readLogs.none { it.start.isNotBlank() && it.finish.isBlank() }) {
                    readLogs.add(ReadLog(start = today, finish = ""))
                }
            }

            BookStatus.WISH -> Unit
        }
    }
}

@Composable
fun BookEditScreen(
    container: AppContainer,
    bookId: Int?,
    onBack: () -> Unit,
    onSaved: () -> Unit,
) {
    var initial by remember(bookId) {
        mutableStateOf(if (bookId == null) BookDraft() else null)
    }
    var loading by remember { mutableStateOf(bookId != null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(bookId, reloadKey) {
        if (bookId != null && initial == null) {
            loading = true
            error = null
            runCatching { container.repository.getBook(bookId) }
                .onSuccess {
                    initial = BookDraft.from(it)
                    loading = false
                }
                .onFailure {
                    error = it.message ?: "加载失败"
                    loading = false
                }
        }
    }

    Scaffold(
        topBar = {
            SmallTopAppBar(
                title = if (bookId == null) "添加书籍" else "编辑书籍",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(imageVector = MiuixIcons.Back, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        val loaded = initial
        when {
            loading && loaded == null -> LoadingView(Modifier.padding(padding))
            error != null && loaded == null -> ErrorView(
                message = error!!,
                onRetry = { reloadKey++ },
                modifier = Modifier.padding(padding),
            )

            loaded != null -> BookEditForm(
                container = container,
                bookId = bookId,
                initial = loaded,
                onSaved = onSaved,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            )
        }
    }
}

@Composable
private fun BookEditForm(
    container: AppContainer,
    bookId: Int?,
    initial: BookDraft,
    onSaved: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val repo = container.repository
    val scope = rememberCoroutineScope()
    val state = remember(initial) { EditState(initial) }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    fun save() {
        if (saving) return
        message = null
        val title = state.title.trim()
        if (title.isEmpty()) {
            message = "书名不能为空"
            return
        }
        val rating = state.ratingText.trim().let {
            if (it.isEmpty()) {
                0.0
            } else {
                val parsed = it.toDoubleOrNull()
                if (parsed == null || parsed < 0.0 || parsed > 10.0) {
                    message = "评分应为 0–10 的数字"
                    return
                }
                parsed
            }
        }
        val seriesIndex = state.seriesIndexText.trim().let {
            if (it.isEmpty()) {
                null
            } else {
                val parsed = it.toDoubleOrNull()
                if (parsed == null || parsed < 0.0) {
                    message = "系列序号应为非负数字"
                    return
                }
                parsed
            }
        }
        val dateRe = Regex("""^\d{4}-\d{2}-\d{2}$""")
        state.readLogs.forEachIndexed { index, log ->
            if (log.start.isNotBlank() && !dateRe.matches(log.start)) {
                message = "第 ${index + 1} 条记录的开始日期格式应为 YYYY-MM-DD"
                return
            }
            if (log.finish.isNotBlank() && !dateRe.matches(log.finish)) {
                message = "第 ${index + 1} 条记录的读完日期格式应为 YYYY-MM-DD"
                return
            }
            if (log.start.isNotBlank() && log.finish.isNotBlank() && log.finish < log.start) {
                message = "第 ${index + 1} 条记录的读完日期不能早于开始日期"
                return
            }
        }
        val draft = BookDraft(
            title = title,
            author = state.author.trim(),
            status = state.status,
            summary = state.summary.trim(),
            tags = state.tagsText.split(Regex("[,，、\\s]+")).map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
            readLogs = state.readLogs.toList(),
            cover = state.cover.trim(),
            notesUrl = state.notesUrl.trim(),
            publisher = state.publisher.trim(),
            pubYear = state.pubYear.trim(),
            isbn = state.isbn.trim(),
            rating = rating,
            series = state.series.trim(),
            seriesIndex = seriesIndex ?: 0.0,
        )
        saving = true
        scope.launch {
            runCatching {
                if (bookId == null) repo.createBook(draft) else repo.updateBook(bookId, draft)
            }.onSuccess {
                saving = false
                onSaved()
            }.onFailure {
                saving = false
                message = it.message ?: "保存失败"
            }
        }
    }

    LazyColumn(
        modifier = modifier.imePadding(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item("cover-preview") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CoverImage(
                    title = state.title.ifBlank { "新书" },
                    coverUrl = repo.coverUrl(state.cover),
                    modifier = Modifier
                        .width(92.dp)
                        .height(134.dp),
                )
                Spacer(Modifier.width(16.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = state.title.ifBlank { "新书" },
                        style = MiuixTheme.textStyles.title3,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.height(4.dp))
                    MetaText(state.author.ifBlank { "作者未填写" })
                }
            }
        }
        item("basic-title") { SectionHeader("基本信息") }
        item("title") {
            FormField(
                value = state.title,
                onValueChange = { state.title = it },
                label = "书名（必填）",
            )
        }
        item("author") {
            FormField(
                value = state.author,
                onValueChange = { state.author = it },
                label = "作者",
            )
        }
        item("status") {
            Column {
                Text(
                    text = "阅读状态",
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
                TabRow(
                    tabs = BookStatus.entries.map { it.label },
                    selectedTabIndex = BookStatus.entries.indexOf(state.status),
                    onTabSelected = { state.selectStatus(BookStatus.entries[it]) },
                )
            }
        }
        item("tags") {
            Column {
                FormField(
                    value = state.tagsText,
                    onValueChange = { state.tagsText = it },
                    label = "标签（用逗号或顿号分隔）",
                )
            }
        }
        item("rating") {
            FormField(
                value = state.ratingText,
                onValueChange = { state.ratingText = it },
                label = "评分（0–10，可留空）",
                keyboardType = KeyboardType.Decimal,
            )
        }
        item("publish-title") { SectionHeader("出版信息") }
        item("series") {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FormField(
                    value = state.series,
                    onValueChange = { state.series = it },
                    label = "系列",
                    modifier = Modifier.weight(2f),
                )
                FormField(
                    value = state.seriesIndexText,
                    onValueChange = { state.seriesIndexText = it },
                    label = "序号",
                    keyboardType = KeyboardType.Decimal,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        item("publisher") {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FormField(
                    value = state.publisher,
                    onValueChange = { state.publisher = it },
                    label = "出版社",
                    modifier = Modifier.weight(2f),
                )
                FormField(
                    value = state.pubYear,
                    onValueChange = { state.pubYear = it },
                    label = "出版年",
                    keyboardType = KeyboardType.Number,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        item("isbn") {
            FormField(
                value = state.isbn,
                onValueChange = { state.isbn = it },
                label = "ISBN",
                keyboardType = KeyboardType.Number,
            )
        }
        item("summary-title") { SectionHeader("简介") }
        item("summary") {
            TextField(
                value = state.summary,
                onValueChange = { state.summary = it },
                modifier = Modifier.fillMaxWidth(),
                label = "图书简介（最多 1000 字）",
                singleLine = false,
                minLines = 4,
                maxLines = 8,
            )
        }
        item("cover-title") { SectionHeader("链接与封面") }
        item("cover-url") {
            FormField(
                value = state.cover,
                onValueChange = { state.cover = it },
                label = "封面图片链接（留空显示占位封面）",
                keyboardType = KeyboardType.Uri,
            )
        }
        item("notes-url") {
            FormField(
                value = state.notesUrl,
                onValueChange = { state.notesUrl = it },
                label = "读书心得链接（GitHub Markdown）",
                keyboardType = KeyboardType.Uri,
            )
        }
        item("logs-title") {
            Column {
                SectionHeader("阅读记录")
                Spacer(Modifier.height(4.dp))
                MetaText("有阅读记录时，读完日期与读过次数会由记录自动推导。")
            }
        }
        itemsIndexed(state.readLogs) { index, log ->
            Card(
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = 14.dp,
                insideMargin = PaddingValues(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "第 ${index + 1} 次阅读",
                            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                            fontSize = 12.sp,
                            modifier = Modifier.padding(bottom = 6.dp),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FormField(
                                value = log.start,
                                onValueChange = {
                                    state.readLogs[index] = log.copy(start = it)
                                },
                                label = "开始日期",
                                modifier = Modifier.weight(1f),
                            )
                            FormField(
                                value = log.finish,
                                onValueChange = {
                                    state.readLogs[index] = log.copy(finish = it)
                                },
                                label = "读完日期",
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                    IconButton(onClick = { state.readLogs.removeAt(index) }) {
                        Icon(
                            imageVector = MiuixIcons.Basic.Close,
                            contentDescription = "删除这条记录",
                        )
                    }
                }
            }
        }
        item("add-log") {
            AddReadLogCard { log -> state.readLogs.add(log) }
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
        item("save") {
            Button(
                onClick = { save() },
                enabled = !saving,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                colors = ButtonDefaults.buttonColors(
                    color = MiuixTheme.colorScheme.primary,
                    contentColor = MiuixTheme.colorScheme.onPrimary,
                ),
            ) {
                Text(if (saving) "保存中…" else "保存")
            }
        }
    }

}

@Composable
private fun AddReadLogCard(onAdd: (ReadLog) -> Unit) {
    var start by remember { mutableStateOf("") }
    var finish by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        cornerRadius = 14.dp,
        insideMargin = PaddingValues(12.dp),
    ) {
        Text(
            text = "添加一次阅读",
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            fontSize = 12.sp,
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FormField(
                value = start,
                onValueChange = { start = it },
                label = "开始日期",
                modifier = Modifier.weight(1f),
            )
            FormField(
                value = finish,
                onValueChange = { finish = it },
                label = "读完日期",
                modifier = Modifier.weight(1f),
            )
        }
        if (error != null) {
            Text(
                text = error!!,
                color = MiuixTheme.colorScheme.primary,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        TextButton(
            text = "添加记录",
            onClick = {
                val dateRe = Regex("""^\d{4}-\d{2}-\d{2}$""")
                if (start.isBlank() && finish.isBlank()) {
                    error = "至少填写一个日期"
                    return@TextButton
                }
                if (start.isNotBlank() && !dateRe.matches(start.trim())) {
                    error = "开始日期格式应为 YYYY-MM-DD"
                    return@TextButton
                }
                if (finish.isNotBlank() && !dateRe.matches(finish.trim())) {
                    error = "读完日期格式应为 YYYY-MM-DD"
                    return@TextButton
                }
                if (start.isNotBlank() && finish.isNotBlank() && finish.trim() < start.trim()) {
                    error = "读完日期不能早于开始日期"
                    return@TextButton
                }
                error = null
                onAdd(ReadLog(start.trim(), finish.trim()))
                start = ""
                finish = ""
            },
        )
    }
}

@Composable
private fun FormField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    TextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        label = label,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
    )
}
