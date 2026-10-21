package top.helloac.mybooks.data

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException
import java.time.LocalDate

data class BookDraft(
    val title: String = "",
    val author: String = "",
    val status: BookStatus = BookStatus.WISH,
    val summary: String = "",
    val tags: List<String> = emptyList(),
    val readLogs: List<ReadLog> = emptyList(),
    val cover: String = "",
    val notesUrl: String = "",
    val publisher: String = "",
    val pubYear: String = "",
    val isbn: String = "",
    val rating: Double? = null,
    val series: String = "",
    val seriesIndex: Double? = null,
) {
    companion object {
        fun from(book: Book) = BookDraft(
            title = book.title,
            author = book.author.orEmpty(),
            status = book.status,
            summary = book.summary.orEmpty(),
            tags = book.tags,
            readLogs = book.readLogs,
            cover = book.cover.orEmpty(),
            notesUrl = book.notesUrl.orEmpty(),
            publisher = book.publisher.orEmpty(),
            pubYear = book.pubYear.orEmpty(),
            isbn = book.isbn.orEmpty(),
            rating = book.rating,
            series = book.series.orEmpty(),
            seriesIndex = book.seriesIndex,
        )
    }
}

class BooksRepository(
    private val settingsStore: SettingsStore,
    private val api: ApiService,
) {
    private val errorJson = Json { ignoreUnknownKeys = true }
    private val _changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    val changes = _changes.asSharedFlow()

    suspend fun listBooks(
        query: String? = null,
        status: BookStatus? = null,
        tag: String? = null,
        author: String? = null,
        sort: String = SORT_UPDATED,
    ): List<Book> = call {
        api.getBooks(
            query = query?.takeIf { it.isNotBlank() },
            status = status?.code,
            tag = tag?.takeIf { it.isNotBlank() },
            author = author?.takeIf { it.isNotBlank() },
            sort = sort,
        )
    }.map { it.toBook() }

    suspend fun getBook(id: Int): Book = call { api.getBook(id) }.toBook()

    suspend fun createBook(draft: BookDraft): Book = call {
        api.createBook(draft.toWriteDto())
    }.toBook().also { _changes.tryEmit(Unit) }

    suspend fun updateBook(id: Int, draft: BookDraft): Book = call {
        api.updateBook(id, draft.toWriteDto())
    }.toBook().also { _changes.tryEmit(Unit) }

    suspend fun deleteBook(id: Int) = call { api.deleteBook(id) }.also { _changes.tryEmit(Unit) }

    suspend fun stats(): Stats = call { api.getStats() }.toStats()

    suspend fun tags(): List<Category> = call { api.getTags() }.map { Category(it.id, it.name, it.count) }

    suspend fun authors(): List<Category> = call { api.getAuthors() }.map { Category(it.id, it.name, it.count) }

    suspend fun series(): List<Series> = call { api.getSeries() }.map {
        Series(it.name, it.count, it.minIndex, it.maxIndex, it.label)
    }

    suspend fun serverSettings(): ServerSettings = call { api.getServerSettings() }.let {
        ServerSettings(it.notesRepo, it.notesBranch)
    }

    suspend fun note(url: String): String = call { api.getNote(url) }.content

    fun absoluteUrl(path: String?): String? {
        val value = path?.trim().orEmpty()
        if (value.isBlank()) return null
        if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:")) return value
        return settingsStore.settings.value.baseUrl.trimEnd('/') + "/" + value.trimStart('/')
    }

    /**
     * Cover URLs are fetched through the server image proxy: external hosts such as
     * doubanio.com answer direct requests with HTTP 418 (hotlink protection).
     */
    fun coverUrl(path: String?): String? {
        val value = path?.trim().orEmpty()
        if (value.isBlank()) return null
        val base = settingsStore.settings.value.baseUrl.trimEnd('/')
        return when {
            value.startsWith("data:") -> value
            value.startsWith("/") -> "$base/" + value.trimStart('/')
            value.startsWith("http://") || value.startsWith("https://") ->
                "$base/api/img-proxy?url=${java.net.URLEncoder.encode(value, "UTF-8")}"

            else -> "$base/$value"
        }
    }

    private suspend fun <T> call(block: suspend () -> T): T = try {
        block()
    } catch (e: HttpException) {
        val payload = e.response()?.errorBody()?.string()
        val parsed = payload?.let {
            runCatching { errorJson.decodeFromString<ApiErrorDto>(it) }.getOrNull()
        }
        throw ApiException(
            status = e.code(),
            code = parsed?.code,
            message = parsed?.error ?: "请求失败（HTTP ${e.code()}）",
        )
    } catch (e: IOException) {
        throw ApiException(0, "NETWORK", "无法连接服务器，请检查地址和网络")
    }

    companion object {
        const val SORT_UPDATED = "updated"
        const val SORT_CREATED = "created"
        const val SORT_FINISH = "finish"
        const val SORT_TITLE = "title"
        const val SORT_AUTHOR = "author"
        const val SORT_SERIES = "series"

        val sortOptions = listOf(
            SORT_UPDATED to "最近更新",
            SORT_CREATED to "添加时间",
            SORT_FINISH to "读完日期",
            SORT_TITLE to "书名",
            SORT_AUTHOR to "作者",
            SORT_SERIES to "系列",
        )

        fun today(): String = LocalDate.now().toString()

        fun applyStatusTransition(draft: BookDraft, oldStatus: BookStatus): BookDraft {
            if (draft.status == oldStatus) return draft
            val today = today()
            val logs = draft.readLogs.toMutableList()
            when (draft.status) {
                BookStatus.DONE -> {
                    val hasFinished = logs.any { it.finish.isNotBlank() }
                    if (!hasFinished) logs.add(ReadLog(start = "", finish = today))
                }

                BookStatus.READING -> {
                    val hasOpen = logs.any { it.start.isNotBlank() && it.finish.isBlank() }
                    if (!hasOpen) logs.add(ReadLog(start = today, finish = ""))
                }

                BookStatus.WISH -> Unit
            }
            return draft.copy(readLogs = logs)
        }
    }
}

private fun BookDraft.toWriteDto() = BookWriteDto(
    title = title.trim(),
    author = author.trim(),
    status = status.code,
    summary = summary.trim(),
    tags = tags.map { it.trim() }.filter { it.isNotBlank() }.distinct(),
    readLogs = readLogs.map { ReadLogDto(it.start.trim(), it.finish.trim()) },
    cover = cover.trim(),
    notesUrl = notesUrl.trim(),
    publisher = publisher.trim(),
    pubYear = pubYear.trim(),
    isbn = isbn.trim(),
    rating = rating,
    series = series.trim(),
    seriesIndex = seriesIndex,
)
