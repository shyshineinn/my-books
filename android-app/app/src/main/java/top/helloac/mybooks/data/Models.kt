package top.helloac.mybooks.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val json = Json { ignoreUnknownKeys = true; isLenient = true }

enum class BookStatus(val code: String, val label: String) {
    WISH("wish", "想读"),
    READING("reading", "在读"),
    DONE("done", "已读");

    companion object {
        fun from(raw: String?): BookStatus = entries.firstOrNull { it.code == raw } ?: WISH
    }
}

data class ReadLog(val start: String, val finish: String) {
    val label: String
        get() = when {
            start.isNotBlank() && finish.isNotBlank() -> "$start → $finish"
            start.isNotBlank() -> "$start 开读"
            else -> "$finish 读完"
        }
}

data class BookFile(val id: Int, val format: String, val path: String, val size: Long)

data class Identifier(val type: String, val label: String, val value: String, val url: String?)

data class Book(
    val id: Int,
    val title: String,
    val author: String?,
    val status: BookStatus,
    val summary: String?,
    val tags: List<String>,
    val startDate: String?,
    val finishDate: String?,
    val cover: String?,
    val notesUrl: String?,
    val readCount: Int,
    val readLogs: List<ReadLog>,
    val rating: Double?,
    val publisher: String?,
    val pubYear: String?,
    val isbn: String?,
    val series: String?,
    val seriesIndex: Double?,
    val seriesLabel: String?,
    val createdAt: String?,
    val updatedAt: String?,
    val customDisplay: Map<String, String>,
    val files: List<BookFile>,
    val identifiers: List<Identifier>,
)

data class Stats(
    val total: Int,
    val byStatus: Map<String, Int>,
    val byYear: Map<String, Int>,
    val topTags: List<NamedCount>,
    val authorTotal: Int,
    val publisherTotal: Int,
    val topAuthors: List<NamedCount>,
    val topPublishers: List<NamedCount>,
) {
    val wish: Int get() = byStatus["wish"] ?: 0
    val reading: Int get() = byStatus["reading"] ?: 0
    val done: Int get() = byStatus["done"] ?: 0
}

data class NamedCount(val name: String, val count: Int)

data class Category(val id: Int, val name: String, val count: Int)

data class Series(val name: String, val count: Int, val minIndex: Double?, val maxIndex: Double?, val label: String)

data class ServerSettings(val notesRepo: String?, val notesBranch: String?)

@Serializable
data class ReadLogDto(
    val start: String = "",
    val finish: String = "",
)

@Serializable
data class BookFileDto(
    val id: Int,
    val format: String,
    val path: String,
    val size: Long = 0,
)

@Serializable
data class IdentifierDto(
    val type: String = "",
    val label: String = "",
    val value: String = "",
    val url: String? = null,
)

@Serializable
data class BookDto(
    val id: Int,
    val title: String = "",
    val author: String? = null,
    val status: String? = null,
    val summary: String? = null,
    val tags: String? = null,
    @SerialName("start_date") val startDate: String? = null,
    @SerialName("finish_date") val finishDate: String? = null,
    val cover: String? = null,
    @SerialName("notes_url") val notesUrl: String? = null,
    @SerialName("read_count") val readCount: Int = 0,
    @SerialName("read_logs") val readLogs: String? = null,
    val rating: Double? = null,
    val publisher: String? = null,
    @SerialName("pub_year") val pubYear: String? = null,
    val isbn: String? = null,
    val series: String? = null,
    @SerialName("series_index") val seriesIndex: Double? = null,
    @SerialName("series_label") val seriesLabel: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("custom_display") val customDisplay: Map<String, String> = emptyMap(),
    val files: List<BookFileDto> = emptyList(),
    @SerialName("identifier_list") val identifierList: List<IdentifierDto> = emptyList(),
)

internal fun BookDto.toBook(): Book = Book(
    id = id,
    title = title,
    author = author?.takeIf { it.isNotBlank() },
    status = BookStatus.from(status),
    summary = summary?.takeIf { it.isNotBlank() },
    tags = parseTags(tags),
    startDate = startDate?.takeIf { it.isNotBlank() },
    finishDate = finishDate?.takeIf { it.isNotBlank() },
    cover = cover?.takeIf { it.isNotBlank() },
    notesUrl = notesUrl?.takeIf { it.isNotBlank() },
    readCount = readCount,
    readLogs = parseReadLogs(readLogs),
    rating = rating,
    publisher = publisher?.takeIf { it.isNotBlank() },
    pubYear = pubYear?.takeIf { it.isNotBlank() },
    isbn = isbn?.takeIf { it.isNotBlank() },
    series = series?.takeIf { it.isNotBlank() },
    seriesIndex = seriesIndex?.takeIf { it > 0.0 },
    seriesLabel = seriesLabel?.takeIf { it.isNotBlank() },
    createdAt = createdAt,
    updatedAt = updatedAt,
    customDisplay = customDisplay,
    files = files.map { BookFile(it.id, it.format, it.path, it.size) },
    identifiers = identifierList.map { Identifier(it.type, it.label, it.value, it.url) },
)

private fun parseTags(raw: String?): List<String> = runCatching {
    json.decodeFromString<List<String>>(raw.orEmpty().ifBlank { "[]" })
}.getOrDefault(emptyList())

private fun parseReadLogs(raw: String?): List<ReadLog> = runCatching {
    json.decodeFromString<List<ReadLogDto>>(raw.orEmpty().ifBlank { "[]" })
        .map { ReadLog(it.start, it.finish) }
        .filter { it.start.isNotBlank() || it.finish.isNotBlank() }
}.getOrDefault(emptyList())

@Serializable
data class BookWriteDto(
    val title: String,
    val author: String? = null,
    val status: String? = null,
    val summary: String? = null,
    val tags: List<String> = emptyList(),
    @SerialName("read_logs") val readLogs: List<ReadLogDto> = emptyList(),
    val cover: String? = null,
    @SerialName("notes_url") val notesUrl: String? = null,
    val publisher: String? = null,
    @SerialName("pub_year") val pubYear: String? = null,
    val isbn: String? = null,
    val rating: Double? = null,
    val series: String? = null,
    @SerialName("series_index") val seriesIndex: Double? = null,
)

@Serializable
data class StatsDto(
    val total: Int = 0,
    val byStatus: Map<String, Int> = emptyMap(),
    val byYear: Map<String, Int> = emptyMap(),
    val topTags: List<TagCountDto> = emptyList(),
    val authorTotal: Int = 0,
    val publisherTotal: Int = 0,
    val topAuthors: List<NamedCountDto> = emptyList(),
    val topPublishers: List<NamedCountDto> = emptyList(),
)

@Serializable
data class TagCountDto(val tag: String = "", val count: Int = 0)

@Serializable
data class NamedCountDto(val name: String = "", val count: Int = 0)

internal fun StatsDto.toStats(): Stats = Stats(
    total = total,
    byStatus = byStatus,
    byYear = byYear,
    topTags = topTags.map { NamedCount(it.tag, it.count) },
    authorTotal = authorTotal,
    publisherTotal = publisherTotal,
    topAuthors = topAuthors.map { NamedCount(it.name, it.count) },
    topPublishers = topPublishers.map { NamedCount(it.name, it.count) },
)

@Serializable
data class CategoryDto(val id: Int, val name: String = "", val count: Int = 0)

@Serializable
data class SeriesDto(
    val name: String = "",
    val count: Int = 0,
    @SerialName("min_index") val minIndex: Double? = null,
    @SerialName("max_index") val maxIndex: Double? = null,
    val label: String = "",
)

@Serializable
data class ServerSettingsDto(
    @SerialName("notesRepo") val notesRepo: String? = null,
    @SerialName("notesBranch") val notesBranch: String? = null,
)

@Serializable
data class NoteDto(val content: String = "")

@Serializable
data class ApiErrorDto(val error: String? = null, val code: String? = null)

data class UpdateManifest(
    val versionCode: Int,
    val versionName: String,
    val apkUrl: String,
    val sha256: String,
    val size: Long,
    val changelog: List<String>,
    val force: Boolean,
    val minSupportedVersionCode: Int,
)

@Serializable
data class UpdateManifestDto(
    val versionCode: Int = 0,
    val versionName: String = "",
    val apkUrl: String = "",
    val sha256: String = "",
    val size: Long = 0,
    val changelog: List<String> = emptyList(),
    val force: Boolean = false,
    val minSupportedVersionCode: Int = 0,
)

internal fun UpdateManifestDto.toManifest(): UpdateManifest = UpdateManifest(
    versionCode = versionCode,
    versionName = versionName,
    apkUrl = apkUrl,
    sha256 = sha256,
    size = size,
    changelog = changelog,
    force = force,
    minSupportedVersionCode = minSupportedVersionCode,
)
