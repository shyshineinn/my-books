package top.helloac.mybooks.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import top.helloac.mybooks.data.Book
import top.helloac.mybooks.data.BookStatus
import top.yukonga.miuix.kmp.basic.CircularProgressIndicator
import top.yukonga.miuix.kmp.basic.SmallTitle
import top.yukonga.miuix.kmp.basic.Surface
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextButton
import top.yukonga.miuix.kmp.theme.MiuixTheme
import java.util.Locale

@Composable
fun BookCover(
    book: Book,
    coverUrl: String?,
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 12.dp,
) {
    CoverImage(
        title = book.title,
        coverUrl = coverUrl,
        modifier = modifier,
        cornerRadius = cornerRadius,
    )
}

@Composable
fun CoverImage(
    title: String,
    coverUrl: String?,
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 12.dp,
) {
    val gradient = remember(title) { coverGradient(title) }
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(cornerRadius))
            .background(Brush.linearGradient(gradient)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = title.trim().take(1).ifBlank { "书" },
            color = Color.White.copy(alpha = 0.9f),
            fontSize = 28.sp,
            fontWeight = FontWeight.Medium,
        )
        if (coverUrl != null) {
            AsyncImage(
                model = coverUrl,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
fun RefreshOnResume(onRefresh: () -> Unit) {
    val firstResume = remember { androidx.compose.runtime.mutableStateOf(true) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        if (firstResume.value) {
            firstResume.value = false
        } else {
            onRefresh()
        }
    }
}

@Composable
fun StatusPill(status: BookStatus, modifier: Modifier = Modifier) {
    val colors = MiuixTheme.colorScheme
    val (background, content) = when (status) {
        BookStatus.WISH -> colors.surfaceContainerHigh to colors.onSurfaceContainerHigh
        BookStatus.READING -> colors.primary to colors.onPrimary
        BookStatus.DONE -> colors.secondaryContainer to colors.onSecondaryContainer
    }
    Surface(
        modifier = modifier,
        shape = CircleShape,
        color = background,
        contentColor = content,
    ) {
        Text(
            text = status.label,
            color = content,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
        )
    }
}

@Composable
fun RatingBadge(rating: Double?, modifier: Modifier = Modifier) {
    if (rating == null || rating <= 0.0) return
    Text(
        text = "★ ${formatRating(rating)}",
        modifier = modifier,
        color = MiuixTheme.colorScheme.primary,
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
    )
}

@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
) {
    SmallTitle(
        text = title,
        modifier = modifier,
        insideMargin = PaddingValues(horizontal = 0.dp, vertical = 8.dp),
    )
}

@Composable
fun EmptyView(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 56.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            style = MiuixTheme.textStyles.body2,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun LoadingView(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 56.dp),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

@Composable
fun ErrorView(
    message: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = message,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            style = MiuixTheme.textStyles.body2,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(16.dp))
        TextButton(text = "重试", onClick = onRetry)
    }
}

@Composable
fun MetaText(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier,
        color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
        fontSize = 12.sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
}

fun formatRating(value: Double): String =
    if (value % 1.0 == 0.0) value.toInt().toString() else String.format(Locale.US, "%.1f", value)

fun formatRating(value: Double?): String = value?.let { formatRating(it) } ?: ""

private fun coverGradient(seed: String): List<Color> {
    val palettes = listOf(
        listOf(Color(0xFF3A3A3A), Color(0xFF111111)),
        listOf(Color(0xFF5A5A5A), Color(0xFF202020)),
        listOf(Color(0xFF2E2E2E), Color(0xFF0A0A0A)),
        listOf(Color(0xFF4A4A4A), Color(0xFF161616)),
        listOf(Color(0xFF6A6A6A), Color(0xFF2A2A2A)),
        listOf(Color(0xFF242424), Color(0xFF080808)),
        listOf(Color(0xFF505050), Color(0xFF1C1C1C)),
        listOf(Color(0xFF767676), Color(0xFF303030)),
    )
    val index = (seed.hashCode() and Int.MAX_VALUE) % palettes.size
    return palettes[index]
}
