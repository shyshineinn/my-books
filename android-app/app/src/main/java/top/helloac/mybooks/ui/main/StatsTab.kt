package top.helloac.mybooks.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.data.NamedCount
import top.helloac.mybooks.data.Stats
import top.helloac.mybooks.ui.common.ErrorView
import top.helloac.mybooks.ui.common.LoadingView
import top.helloac.mybooks.ui.common.RefreshOnResume
import top.helloac.mybooks.ui.common.SectionHeader
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.theme.MiuixTheme

@Composable
fun StatsTab(container: AppContainer, refreshTick: Int = 0) {
    var stats by remember { mutableStateOf<Stats?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableIntStateOf(0) }

    RefreshOnResume { reloadKey++ }

    LaunchedEffect(reloadKey, refreshTick) {
        loading = true
        error = null
        runCatching { container.repository.stats() }
            .onSuccess {
                stats = it
                loading = false
            }
            .onFailure {
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
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                item("hero") { StatsHero(current) }
                item("years") {
                    Column {
                        SectionHeader("每年读完")
                        Spacer(Modifier.height(10.dp))
                        YearChart(current.byYear)
                    }
                }
                if (current.topTags.isNotEmpty()) {
                    item("tags") {
                        Column {
                            SectionHeader("标签分布")
                            Spacer(Modifier.height(10.dp))
                            CountBars(current.topTags, "本")
                        }
                    }
                }
                if (current.topAuthors.isNotEmpty()) {
                    item("authors") {
                        Column {
                            SectionHeader("作者 Top ${current.topAuthors.size}")
                            Spacer(Modifier.height(10.dp))
                            CountBars(current.topAuthors, "本")
                        }
                    }
                }
                if (current.topPublishers.isNotEmpty()) {
                    item("publishers") {
                        Column {
                            SectionHeader("出版社 Top ${current.topPublishers.size}")
                            Spacer(Modifier.height(10.dp))
                            CountBars(current.topPublishers, "本")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StatsHero(stats: Stats) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        cornerRadius = 22.dp,
        insideMargin = PaddingValues(20.dp),
    ) {
        Column {
            Text(
                text = "阅读印象",
                style = MiuixTheme.textStyles.title3,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(14.dp))
            Row(modifier = Modifier.fillMaxWidth()) {
                HeroStat("藏书", stats.total, Modifier.weight(1f))
                HeroStat("已读", stats.done, Modifier.weight(1f), highlight = true)
                HeroStat("在读", stats.reading, Modifier.weight(1f))
                HeroStat("想读", stats.wish, Modifier.weight(1f))
            }
            if (stats.total > 0) {
                Spacer(Modifier.height(14.dp))
                val fraction = stats.done.toFloat() / stats.total.toFloat()
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(CircleShape)
                        .background(MiuixTheme.colorScheme.surfaceContainerHighest),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(fraction.coerceIn(0f, 1f))
                            .fillMaxHeight()
                            .clip(CircleShape)
                            .background(MiuixTheme.colorScheme.primary),
                    )
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "已读 ${(fraction * 100).toInt()}%",
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 11.sp,
                )
            }
        }
    }
}

@Composable
private fun HeroStat(
    label: String,
    value: Int,
    modifier: Modifier = Modifier,
    highlight: Boolean = false,
) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = value.toString(),
            style = MiuixTheme.textStyles.title2,
            fontWeight = FontWeight.Bold,
            color = if (highlight) MiuixTheme.colorScheme.primary else MiuixTheme.colorScheme.onSurface,
        )
        Text(
            text = label,
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun YearChart(byYear: Map<String, Int>) {
    if (byYear.isEmpty()) {
        Text(
            text = "还没有读完记录",
            color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            fontSize = 13.sp,
        )
        return
    }
    val max = byYear.values.maxOrNull()?.coerceAtLeast(1) ?: 1
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        byYear.entries.sortedBy { it.key }.forEach { (year, count) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = year,
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 12.sp,
                    modifier = Modifier.width(44.dp),
                )
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(9.dp)
                        .clip(CircleShape)
                        .background(MiuixTheme.colorScheme.surfaceContainerHighest),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth((count.toFloat() / max).coerceIn(0.02f, 1f))
                            .fillMaxHeight()
                            .clip(CircleShape)
                            .background(MiuixTheme.colorScheme.primary),
                    )
                }
                Text(
                    text = count.toString(),
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 12.sp,
                    modifier = Modifier
                        .width(36.dp)
                        .padding(start = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun CountBars(items: List<NamedCount>, unit: String) {
    val max = items.maxOfOrNull { it.count }?.coerceAtLeast(1) ?: 1
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items.forEach { item ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = item.name,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.width(82.dp),
                )
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(7.dp)
                        .clip(CircleShape)
                        .background(MiuixTheme.colorScheme.surfaceContainerHighest),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth((item.count.toFloat() / max).coerceIn(0.02f, 1f))
                            .fillMaxHeight()
                            .clip(CircleShape)
                            .background(MiuixTheme.colorScheme.secondary),
                    )
                }
                Text(
                    text = "${item.count}$unit",
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                    fontSize = 11.sp,
                    modifier = Modifier
                        .width(42.dp)
                        .padding(start = 8.dp),
                )
            }
        }
    }
}
