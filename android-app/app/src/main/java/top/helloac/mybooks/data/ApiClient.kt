package top.helloac.mybooks.data

import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

class ApiClient(private val settingsStore: SettingsStore) {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        explicitNulls = false
        encodeDefaults = true
    }

    private val client = OkHttpClient.Builder()
        .addInterceptor(BaseUrlInterceptor { settingsStore.settings.value.baseUrl })
        .apply {
            addInterceptor(
                HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC },
            )
        }
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val retrofit = Retrofit.Builder()
        .baseUrl(DEFAULT_BASE_URL)
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    val api: ApiService = retrofit.create(ApiService::class.java)
}

private class BaseUrlInterceptor(private val baseUrl: () -> String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val base = baseUrl().toHttpUrlOrNull() ?: return chain.proceed(request)
        val old = request.url
        if (old.scheme == base.scheme && old.host == base.host && old.port == base.port) {
            return chain.proceed(request)
        }
        val rebuilt = old.newBuilder()
            .scheme(base.scheme)
            .host(base.host)
            .port(base.port)
            .build()
        return chain.proceed(request.newBuilder().url(rebuilt).build())
    }
}

class ApiException(
    val status: Int,
    val code: String?,
    override val message: String,
) : Exception(message)
