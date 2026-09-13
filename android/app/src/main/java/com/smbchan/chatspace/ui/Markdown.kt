package com.smbchan.chatspace.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private sealed interface Block {
    data class Heading(val level: Int, val text: String) : Block
    data class Paragraph(val text: String) : Block
    data class ListItem(val text: String, val ordered: Boolean, val index: Int, val indent: Int) : Block
    data class Code(val code: String) : Block
    data class Quote(val text: String) : Block
    data class Table(val header: List<String>, val rows: List<List<String>>) : Block
    data object Rule : Block
}

private val artifactRegex =
    Regex("```artifact[^\\n]*\\n[\\s\\S]*?```", RegexOption.IGNORE_CASE)

private val inlineRegex = Regex(
    """\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|~~(.+?)~~|`([^`\n]+)`|\[([^\]]+)\]\((https?://[^)\s]+)\)""",
)

private val tableSeparatorRegex = Regex("""^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$""")
private val hrRegex = Regex("""^\s*(-{3,}|\*{3,}|_{3,})\s*$""")
private val orderedListRegex = Regex("""^(\s*)(\d+)[.)]\s+(.*)$""")
private val bulletListRegex = Regex("""^(\s*)[-*+]\s+(.*)$""")
private val quoteRegex = Regex("""^\s*>\s?(.*)$""")

/** 軽量 Markdown レンダラ (見出し/リスト/太字/斜体/打消し/コード/リンク/引用/表/水平線)。 */
@Composable
fun MarkdownText(markdown: String, modifier: Modifier = Modifier) {
    val cleaned = remember(markdown) {
        markdown
            .replace(artifactRegex, "_ファイルを生成しました。_")
            .replace(Regex("\n{3,}"), "\n\n")
            .trim()
    }
    val blocks = remember(cleaned) { parseBlocks(cleaned) }
    Column(modifier = modifier) {
        blocks.forEach { block ->
            when (block) {
                is Block.Heading -> Text(
                    buildInline(block.text),
                    color = MaterialTheme.colorScheme.onSurface,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = when (block.level) {
                        1 -> 19.sp
                        2 -> 17.sp
                        else -> 16.sp
                    },
                    modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                )
                is Block.Paragraph -> Text(
                    buildInline(block.text),
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = 15.sp,
                    lineHeight = 24.sp,
                    modifier = Modifier.padding(vertical = 3.dp),
                )
                is Block.ListItem -> Row(
                    modifier = Modifier.padding(
                        start = (4 + block.indent * 14).dp,
                        top = 2.dp,
                        bottom = 2.dp,
                    ),
                ) {
                    Text(
                        if (block.ordered) "${block.index}." else "•",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 15.sp,
                        modifier = Modifier.padding(end = 8.dp),
                    )
                    Text(
                        buildInline(block.text),
                        color = MaterialTheme.colorScheme.onSurface,
                        fontSize = 15.sp,
                        lineHeight = 23.sp,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                is Block.Code -> Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 6.dp),
                ) {
                    Text(
                        block.code,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        lineHeight = 19.sp,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.padding(12.dp),
                    )
                }
                is Block.Quote -> Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(IntrinsicSize.Min)
                        .padding(vertical = 4.dp),
                ) {
                    Box(
                        Modifier
                            .width(3.dp)
                            .fillMaxHeight()
                            .background(
                                MaterialTheme.colorScheme.primary.copy(alpha = 0.55f),
                                RoundedCornerShape(2.dp),
                            ),
                    )
                    Text(
                        buildInline(block.text),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontStyle = FontStyle.Italic,
                        fontSize = 15.sp,
                        lineHeight = 23.sp,
                        modifier = Modifier
                            .padding(start = 10.dp)
                            .fillMaxWidth(),
                    )
                }
                is Block.Table -> MarkdownTable(block)
                is Block.Rule -> HorizontalDivider(
                    color = MaterialTheme.colorScheme.outlineVariant,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun MarkdownTable(block: Block.Table) {
    val columns = maxOf(
        block.header.size,
        block.rows.maxOfOrNull { it.size } ?: 0,
    ).coerceAtLeast(1)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
    ) {
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Row(Modifier.fillMaxWidth()) {
                repeat(columns) { c ->
                    Text(
                        buildInline(block.header.getOrElse(c) { "" }),
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp,
                        lineHeight = 19.sp,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 8.dp, vertical = 7.dp),
                    )
                }
            }
        }
        block.rows.forEachIndexed { index, row ->
            Row(Modifier.fillMaxWidth()) {
                repeat(columns) { c ->
                    Text(
                        buildInline(row.getOrElse(c) { "" }),
                        fontSize = 13.sp,
                        lineHeight = 19.sp,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    )
                }
            }
            if (index < block.rows.lastIndex) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
    }
}

private fun parseRowCells(line: String): List<String> {
    var s = line.trim()
    if (s.startsWith("|")) s = s.substring(1)
    if (s.endsWith("|")) s = s.substring(0, s.length - 1)
    return s.split("|").map { it.trim() }
}

private fun parseBlocks(source: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val paragraph = mutableListOf<String>()
    val lines = source.lines()
    var listIndex = 0

    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            blocks.add(Block.Paragraph(paragraph.joinToString("\n")))
            paragraph.clear()
        }
        listIndex = 0
    }

    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trimStart()
        when {
            trimmed.startsWith("```") -> {
                flushParagraph()
                val code = StringBuilder()
                i += 1
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    code.appendLine(lines[i])
                    i += 1
                }
                blocks.add(Block.Code(code.toString().trimEnd()))
            }
            line.contains('|') && i + 1 < lines.size && tableSeparatorRegex.matches(lines[i + 1]) -> {
                flushParagraph()
                val header = parseRowCells(line)
                i += 2 // ヘッダ行 + セパレータ
                val rows = mutableListOf<List<String>>()
                while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
                    rows.add(parseRowCells(lines[i]))
                    i += 1
                }
                blocks.add(Block.Table(header, rows))
                continue
            }
            trimmed.startsWith("#") -> {
                flushParagraph()
                val level = trimmed.takeWhile { it == '#' }.length.coerceAtMost(3)
                val text = trimmed.dropWhile { it == '#' }.trim()
                if (text.isNotEmpty()) blocks.add(Block.Heading(level, text))
            }
            hrRegex.matches(line) && paragraph.isEmpty() -> {
                flushParagraph()
                blocks.add(Block.Rule)
            }
            quoteRegex.matches(line) -> {
                flushParagraph()
                val quoted = StringBuilder()
                while (i < lines.size && quoteRegex.matches(lines[i])) {
                    quoted.appendLine(quoteRegex.matchEntire(lines[i])!!.groupValues[1])
                    i += 1
                }
                blocks.add(Block.Quote(quoted.toString().trim()))
                continue
            }
            bulletListRegex.matches(line) -> {
                flushParagraph()
                val match = bulletListRegex.matchEntire(line)!!
                val indent = match.groupValues[1].length / 2
                blocks.add(Block.ListItem(match.groupValues[2].trim(), ordered = false, index = 0, indent = indent))
            }
            orderedListRegex.matches(line) -> {
                flushParagraph()
                val match = orderedListRegex.matchEntire(line)!!
                val indent = match.groupValues[1].length / 2
                listIndex += 1
                blocks.add(
                    Block.ListItem(
                        match.groupValues[3].trim(),
                        ordered = true,
                        index = listIndex,
                        indent = indent,
                    ),
                )
            }
            line.isBlank() -> flushParagraph()
            else -> paragraph.add(line)
        }
        i += 1
    }
    flushParagraph()
    return blocks
}

private val codeBackground = Color(0x2E8080FF)
private val linkColor = Color(0xFF9BA0F8)

private fun buildInline(text: String): AnnotatedString = buildAnnotatedString {
    var index = 0
    for (match in inlineRegex.findAll(text)) {
        if (match.range.first > index) append(text.substring(index, match.range.first))
        when {
            match.groupValues[1].isNotEmpty() -> withStyle(
                SpanStyle(fontWeight = FontWeight.Bold),
            ) { append(match.groupValues[1]) }
            match.groupValues[2].isNotEmpty() -> withStyle(
                SpanStyle(fontStyle = FontStyle.Italic),
            ) { append(match.groupValues[2]) }
            match.groupValues[3].isNotEmpty() -> withStyle(
                SpanStyle(fontWeight = FontWeight.Bold),
            ) { append(match.groupValues[3]) }
            match.groupValues[4].isNotEmpty() -> withStyle(
                SpanStyle(textDecoration = TextDecoration.LineThrough),
            ) { append(match.groupValues[4]) }
            match.groupValues[5].isNotEmpty() -> withStyle(
                SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground),
            ) { append(match.groupValues[5]) }
            match.groupValues[6].isNotEmpty() -> {
                val label = match.groupValues[6]
                val url = match.groupValues[7]
                withLink(
                    LinkAnnotation.Url(
                        url,
                        TextLinkStyles(
                            style = SpanStyle(
                                color = linkColor,
                                textDecoration = TextDecoration.Underline,
                            ),
                        ),
                    ),
                ) { append(label) }
            }
        }
        index = match.range.last + 1
    }
    if (index < text.length) append(text.substring(index))
}
