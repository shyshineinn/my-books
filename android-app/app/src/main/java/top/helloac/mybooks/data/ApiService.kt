package top.helloac.mybooks.data

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

interface ApiService {
    @GET("api/v1/books")
    suspend fun getBooks(
        @Query("q") query: String? = null,
        @Query("status") status: String? = null,
        @Query("tag") tag: String? = null,
        @Query("author") author: String? = null,
        @Query("vl") virtualLibrary: String? = null,
        @Query("sort") sort: String? = null,
    ): List<BookDto>

    @GET("api/v1/books/{id}")
    suspend fun getBook(@Path("id") id: Int): BookDto

    @POST("api/v1/books")
    suspend fun createBook(@Body body: BookWriteDto): BookDto

    @PUT("api/v1/books/{id}")
    suspend fun updateBook(@Path("id") id: Int, @Body body: BookWriteDto): BookDto

    @DELETE("api/v1/books/{id}")
    suspend fun deleteBook(@Path("id") id: Int)

    @GET("api/v1/stats")
    suspend fun getStats(@Query("vl") virtualLibrary: String? = null): StatsDto

    @GET("api/v1/tags")
    suspend fun getTags(@Query("vl") virtualLibrary: String? = null): List<CategoryDto>

    @GET("api/v1/authors")
    suspend fun getAuthors(@Query("vl") virtualLibrary: String? = null): List<CategoryDto>

    @GET("api/v1/series")
    suspend fun getSeries(@Query("vl") virtualLibrary: String? = null): List<SeriesDto>

    @GET("api/v1/settings")
    suspend fun getServerSettings(): ServerSettingsDto

    @GET("api/v1/notes")
    suspend fun getNote(@Query("url") url: String): NoteDto

    @GET("app/latest.json")
    suspend fun getUpdateManifest(@Query("t") cacheBuster: Long): UpdateManifestDto
}
