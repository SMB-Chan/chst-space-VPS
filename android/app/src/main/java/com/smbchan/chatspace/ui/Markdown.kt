package com.smbchan.chatspace.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
    data class ListItem(val text: String, val ordered: Boolean, val index: Int) : Block
    data class Code(val code: String) : Block
}

private val artifactRegex =
    Regex("```artifact[^\\n]*\\n[\\s\\S]*?```", RegexOption.IGNORE_CASE)

private val inlineRegex = Regex(
    """\*\*(.+?)\*\*|\*(.+?)\*|`([^`\n]+)`|\[([^\]]+)\]\((https?://[^)\s]+)\)""",
)

/** 軽量 Markdown レンダラ (見出し/箇条書き/太字/斜体/コード/リンク対応)。 */
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
                is Block.ListItem -> Row(modifier = Modifier.padding(start = 2.dp, top = 2.dp, bottom = 2.dp)) {
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
            }
        }
    }
}

private fun parseBlocks(source: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val paragraph = mutableListOf<String>()
    var listIndex = 0

    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            blocks.add(Block.Paragraph(paragraph.joinToString("\n")))
            paragraph.clear()
        }
        listIndex = 0
    }

    val lines = source.lines()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        when {
            line.trimStart().startsWith("```") -> {
                flushParagraph()
                val code = StringBuilder()
                i += 1
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    code.appendLine(lines[i])
                    i += 1
                }
                blocks.add(Block.Code(code.toString().trimEnd()))
            }
            line.startsWith("#") -> {
                flushParagraph()
                val level = line.takeWhile { it == '#' }.length.coerceAtMost(3)
                val text = line.dropWhile { it == '#' }.trim()
                if (text.isNotEmpty()) blocks.add(Block.Heading(level, text))
            }
            line.trimStart().startsWith("- ") || line.trimStart().startsWith("* ") -> {
                flushParagraph()
                blocks.add(Block.ListItem(line.trimStart().drop(2).trim(), ordered = false, index = 0))
            }
            Regex("""^\s*\d+[.)]\s+""").containsMatchIn(line) -> {
                flushParagraph()
                listIndex += 1
                blocks.add(
                    Block.ListItem(
                        line.trimStart().replace(Regex("""^\d+[.)]\s+"""), ""),
                        ordered = true,
                        index = listIndex,
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
                SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground),
            ) { append(match.groupValues[3]) }
            match.groupValues[4].isNotEmpty() -> {
                val label = match.groupValues[4]
                val url = match.groupValues[5]
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
