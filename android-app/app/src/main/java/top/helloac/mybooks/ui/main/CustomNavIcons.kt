package top.helloac.mybooks.ui.main

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

val RankBarsIcon: ImageVector by lazy {
    ImageVector.Builder(
        name = "RankBars",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        addStrokePath("M4.8,14 H6.2 A1.2,1.2 0 0 1 7.4,15.2 V19.8 A1.2,1.2 0 0 1 6.2,21 H4.8 A1.2,1.2 0 0 1 3.6,19.8 V15.2 A1.2,1.2 0 0 1 4.8,14 Z")
        addStrokePath("M11.4,3 H12.8 A1.2,1.2 0 0 1 14,4.2 V19.8 A1.2,1.2 0 0 1 12.8,21 H11.4 A1.2,1.2 0 0 1 10.2,19.8 V4.2 A1.2,1.2 0 0 1 11.4,3 Z")
        addStrokePath("M18,9 H19.4 A1.2,1.2 0 0 1 20.6,10.2 V19.8 A1.2,1.2 0 0 1 19.4,21 H18 A1.2,1.2 0 0 1 16.8,19.8 V10.2 A1.2,1.2 0 0 1 18,9 Z")
    }.build()
}

val ShelfBooksIcon: ImageVector by lazy {
    ImageVector.Builder(
        name = "ShelfBooks",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        addStrokePath("M18.6,5.2 H8.4 C6,5.2 3.9,6.3 3.4,7.7 C3.2,8.4 3.6,9 4.3,9 C5.6,9 7,10.2 9,10.2 H18.6 A2.4,2.4 0 0 0 21,7.7 A2.4,2.4 0 0 0 18.6,5.2 Z")
        addStrokePath("M18.6,13.6 H8.4 C6,13.6 3.9,14.7 3.4,16.1 C3.2,16.8 3.6,17.4 4.3,17.4 C5.6,17.4 7,18.6 9,18.6 H18.6 A2.4,2.4 0 0 0 21,16.1 A2.4,2.4 0 0 0 18.6,13.6 Z")
    }.build()
}

private fun ImageVector.Builder.addStrokePath(pathData: String) {
    addPath(
        pathData = PathParser().parsePathString(pathData).toNodes(),
        stroke = SolidColor(Color.Black),
        strokeLineWidth = 1.8f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    )
}
