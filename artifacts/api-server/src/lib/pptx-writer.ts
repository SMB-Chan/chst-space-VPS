import { deflateRawSync } from "node:zlib";

export interface PptxSlide {
  title: string;
  bullets: string[];
}

export interface PptxWriterLimits {
  maxSlides: number;
  maxBulletsPerSlide: number;
  maxTextRuns: number;
  maxTextCharacters: number;
  maxTextBytes: number;
  maxOutputBytes: number;
}

export const DEFAULT_PPTX_WRITER_LIMITS: Readonly<PptxWriterLimits> =
  Object.freeze({
    maxSlides: 100,
    maxBulletsPerSlide: 200,
    maxTextRuns: 10_000,
    maxTextCharacters: 32_767,
    maxTextBytes: 8 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
  });

const ZIP32_MAX_ENTRIES = 65_535;
const ZIP32_MAX_VALUE = 0xffff_ffff;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DEFLATE_METHOD = 8;
const ZIP_DOS_EPOCH_DATE = 33;
const SLIDE_WIDTH = 12_192_000;
const SLIDE_HEIGHT = 6_858_000;

interface ZipEntry {
  name: string;
  data: Buffer;
}

function resolveLimits(overrides: Partial<PptxWriterLimits>): PptxWriterLimits {
  const limits = { ...DEFAULT_PPTX_WRITER_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`PPTX ${name} must be a positive safe integer`);
    }
  }
  if (limits.maxSlides * 2 + 11 > ZIP32_MAX_ENTRIES) {
    throw new Error("PPTX slide limit exceeds the ZIP32 entry limit");
  }
  if (limits.maxOutputBytes > ZIP32_MAX_VALUE) {
    throw new Error("PPTX output limit exceeds the ZIP32 size limit");
  }
  return limits;
}

function stripInvalidXmlCharacters(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,
    "",
  );
}

function escapeXml(value: string): string {
  return stripInvalidXmlCharacters(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function textNode(value: string): string {
  return `<a:t xml:space="preserve">${escapeXml(value)}</a:t>`;
}

function validateSlides(
  slides: readonly PptxSlide[],
  title: string,
  limits: PptxWriterLimits,
): PptxSlide[] {
  if (slides.length === 0)
    throw new Error("PPTX presentation must contain at least one slide");
  if (slides.length > limits.maxSlides) {
    throw new Error(
      `PPTX presentation exceeds the ${limits.maxSlides}-slide limit`,
    );
  }

  if (title.length > limits.maxTextCharacters) {
    throw new Error(
      `PPTX text exceeds the ${limits.maxTextCharacters}-character limit`,
    );
  }
  let textRuns = 1;
  let textBytes = Buffer.byteLength(title, "utf8");
  if (textBytes > limits.maxTextBytes) {
    throw new Error(`PPTX text exceeds the ${limits.maxTextBytes}-byte limit`);
  }
  const countText = (value: string): string => {
    if (value.length > limits.maxTextCharacters) {
      throw new Error(
        `PPTX text exceeds the ${limits.maxTextCharacters}-character limit`,
      );
    }
    textRuns += 1;
    if (textRuns > limits.maxTextRuns) {
      throw new Error(
        `PPTX presentation exceeds the ${limits.maxTextRuns}-text-run limit`,
      );
    }
    textBytes += Buffer.byteLength(value, "utf8");
    if (textBytes > limits.maxTextBytes) {
      throw new Error(
        `PPTX text exceeds the ${limits.maxTextBytes}-byte limit`,
      );
    }
    return value;
  };

  return slides.map((slide) => {
    if (slide.bullets.length > limits.maxBulletsPerSlide) {
      throw new Error(
        `PPTX slide exceeds the ${limits.maxBulletsPerSlide}-bullet limit`,
      );
    }
    return {
      title: countText(slide.title),
      bullets: slide.bullets.map(countText),
    };
  });
}

function groupShapeXml(): string {
  return [
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>',
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
  ].join("");
}

function textShapeXml(options: {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  paragraphs: string;
  anchor?: "ctr" | "t";
}): string {
  return [
    "<p:sp><p:nvSpPr>",
    `<p:cNvPr id="${options.id}" name="${escapeXml(options.name)}"/>`,
    '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>',
    "<p:spPr><a:xfrm>",
    `<a:off x="${options.x}" y="${options.y}"/><a:ext cx="${options.width}" cy="${options.height}"/>`,
    '</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>',
    "<a:ln><a:noFill/></a:ln></p:spPr>",
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="${options.anchor ?? "t"}"/>`,
    `<a:lstStyle/>${options.paragraphs}</p:txBody></p:sp>`,
  ].join("");
}

function titleParagraphXml(title: string): string {
  return [
    '<a:p><a:pPr algn="l"/>',
    '<a:r><a:rPr lang="ja-JP" sz="2400" b="1" dirty="0" smtClean="0"/>',
    textNode(title),
    '</a:r><a:endParaRPr lang="ja-JP" sz="2400" dirty="0"/></a:p>',
  ].join("");
}

function bulletParagraphXml(bullet: string): string {
  return [
    '<a:p><a:pPr marL="342900" indent="-285750">',
    '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>',
    '<a:r><a:rPr lang="ja-JP" sz="1600" dirty="0" smtClean="0"/>',
    textNode(bullet),
    '</a:r><a:endParaRPr lang="ja-JP" sz="1600" dirty="0"/></a:p>',
  ].join("");
}

function emptyParagraphXml(): string {
  return '<a:p><a:endParaRPr lang="ja-JP" sz="1600" dirty="0"/></a:p>';
}

function slideXml(slide: PptxSlide): string {
  const bullets =
    slide.bullets.length > 0
      ? slide.bullets.map(bulletParagraphXml).join("")
      : emptyParagraphXml();
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    "<p:cSld><p:spTree>",
    groupShapeXml(),
    textShapeXml({
      id: 2,
      name: "Title 1",
      x: 457_200,
      y: 342_900,
      width: 11_277_600,
      height: 914_400,
      paragraphs: titleParagraphXml(slide.title),
      anchor: "ctr",
    }),
    textShapeXml({
      id: 3,
      name: "Content 2",
      x: 457_200,
      y: 1_371_600,
      width: 11_277_600,
      height: 4_800_600,
      paragraphs: bullets,
    }),
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
  ].join("");
}

function slideRelationshipsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
    "</Relationships>",
  ].join("");
}

function presentationXml(slideCount: number): string {
  const slideIds = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>',
    `<p:sldIdLst>${slideIds}</p:sldIdLst>`,
    `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}" type="screen16x9"/>`,
    '<p:notesSz cx="6858000" cy="9144000"/>',
    '<p:defaultTextStyle><a:defPPr><a:defRPr lang="ja-JP"/></a:defPPr></p:defaultTextStyle>',
    "</p:presentation>",
  ].join("");
}

function presentationRelationshipsXml(slideCount: number): string {
  const slides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
    slides,
    "</Relationships>",
  ].join("");
}

function slideMasterXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    `<p:cSld name="Chat Space"><p:spTree>${groupShapeXml()}</p:spTree></p:cSld>`,
    '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>',
    '<p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst>',
    '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="2400" b="1"/></a:lvl1pPr></p:titleStyle>',
    '<p:bodyStyle><a:lvl1pPr marL="342900" indent="-285750"><a:defRPr sz="1600"/></a:lvl1pPr></p:bodyStyle>',
    '<p:otherStyle><a:defPPr><a:defRPr lang="ja-JP"/></a:defPPr></p:otherStyle></p:txStyles>',
    "</p:sldMaster>",
  ].join("");
}

const SLIDE_MASTER_RELATIONSHIPS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>',
  "</Relationships>",
].join("");

const SLIDE_LAYOUT_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">',
  `<p:cSld name="Blank"><p:spTree>${groupShapeXml()}</p:spTree></p:cSld>`,
  "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
].join("");

const SLIDE_LAYOUT_RELATIONSHIPS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>',
  "</Relationships>",
].join("");

const THEME_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Chat Space">',
  '<a:themeElements><a:clrScheme name="Chat Space">',
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>',
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>',
  '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>',
  '<a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="7C3AED"/></a:accent2>',
  '<a:accent3><a:srgbClr val="059669"/></a:accent3><a:accent4><a:srgbClr val="D97706"/></a:accent4>',
  '<a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6>',
  '<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>',
  '</a:clrScheme><a:fontScheme name="Chat Space">',
  '<a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Noto Sans CJK JP"/><a:cs typeface="Arial"/></a:majorFont>',
  '<a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Noto Sans CJK JP"/><a:cs typeface="Arial"/></a:minorFont>',
  '</a:fontScheme><a:fmtScheme name="Chat Space">',
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="100000"/><a:satMod val="200000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill>',
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>',
  '<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>',
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>',
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>',
  "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>",
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>',
  "</a:fmtScheme></a:themeElements></a:theme>",
].join("");

function contentTypesXml(slideCount: number): string {
  const slides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    slides,
    "</Types>",
  ].join("");
}

const ROOT_RELATIONSHIPS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>',
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
  "</Relationships>",
].join("");

function corePropertiesXml(title: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ',
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ',
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapeXml(title)}</dc:title><dc:creator>Chat Space</dc:creator>`,
    "<cp:lastModifiedBy>Chat Space</cp:lastModifiedBy>",
    '<dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created>',
    '<dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified>',
    "</cp:coreProperties>",
  ].join("");
}

function appPropertiesXml(slideCount: number): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ',
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    `<Application>Chat Space</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${slideCount}</Slides>`,
    "<Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop>",
    "<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>",
    "<HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>",
  ].join("");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function assertZip32Value(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX_VALUE) {
    throw new Error(`PPTX ${label} exceeds the ZIP32 limit`);
  }
}

function createZip(
  entries: readonly ZipEntry[],
  maxOutputBytes: number,
): Buffer {
  if (entries.length === 0 || entries.length > ZIP32_MAX_ENTRIES) {
    throw new Error("PPTX ZIP entry count is outside the ZIP32 range");
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    if (name.length === 0 || name.length > 0xffff) {
      throw new Error("PPTX ZIP entry name is outside the ZIP32 range");
    }
    const compressed = deflateRawSync(entry.data, { level: 6 });
    assertZip32Value(entry.data.length, "uncompressed entry size");
    assertZip32Value(compressed.length, "compressed entry size");
    assertZip32Value(localOffset, "local header offset");

    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(ZIP_DEFLATE_METHOD, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(ZIP_DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(ZIP_DEFLATE_METHOD, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(ZIP_DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);

    localParts.push(local, compressed);
    centralParts.push(central);
    centralSize += central.length;
    localOffset += local.length + compressed.length;
    assertZip32Value(localOffset, "local data size");
    assertZip32Value(centralSize, "central directory size");
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  const output = Buffer.concat([...localParts, ...centralParts, end]);
  if (output.length > maxOutputBytes) {
    throw new Error(`PPTX output exceeds the ${maxOutputBytes}-byte limit`);
  }
  return output;
}

function xmlEntry(name: string, content: string): ZipEntry {
  return { name, data: Buffer.from(content, "utf8") };
}

export function writePptxPresentation(
  slides: readonly PptxSlide[],
  title = "Presentation",
  overrides: Partial<PptxWriterLimits> = {},
): Buffer {
  const limits = resolveLimits(overrides);
  const normalizedSlides = validateSlides(slides, title, limits);
  const entries: ZipEntry[] = [
    xmlEntry("[Content_Types].xml", contentTypesXml(normalizedSlides.length)),
    xmlEntry("_rels/.rels", ROOT_RELATIONSHIPS_XML),
    xmlEntry("docProps/core.xml", corePropertiesXml(title)),
    xmlEntry("docProps/app.xml", appPropertiesXml(normalizedSlides.length)),
    xmlEntry("ppt/presentation.xml", presentationXml(normalizedSlides.length)),
    xmlEntry(
      "ppt/_rels/presentation.xml.rels",
      presentationRelationshipsXml(normalizedSlides.length),
    ),
    xmlEntry("ppt/slideMasters/slideMaster1.xml", slideMasterXml()),
    xmlEntry(
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      SLIDE_MASTER_RELATIONSHIPS_XML,
    ),
    xmlEntry("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT_XML),
    xmlEntry(
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      SLIDE_LAYOUT_RELATIONSHIPS_XML,
    ),
    xmlEntry("ppt/theme/theme1.xml", THEME_XML),
  ];
  for (let index = 0; index < normalizedSlides.length; index += 1) {
    entries.push(
      xmlEntry(
        `ppt/slides/slide${index + 1}.xml`,
        slideXml(normalizedSlides[index]),
      ),
      xmlEntry(
        `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        slideRelationshipsXml(),
      ),
    );
  }
  return createZip(entries, limits.maxOutputBytes);
}
