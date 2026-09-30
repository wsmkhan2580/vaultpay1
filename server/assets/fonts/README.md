# Optional Unicode fonts for receipt PDFs

The receipt PDF uses PDFKit's built-in Helvetica, which can only draw Latin-1 characters.
Names or addresses in Hindi, Arabic, Chinese, etc. (and symbols such as the rupee sign) are
replaced with `?` / a currency code so the PDF never shows garbled glyphs.

To render full Unicode, download **Noto Sans** (SIL Open Font License, https://fonts.google.com/noto/specimen/Noto+Sans)
and place these two files here:

    NotoSans-Regular.ttf
    NotoSans-Bold.ttf

No code change is needed - `pdfService.ts` detects the files at start-up and switches automatically.
(For Hindi text use *Noto Sans Devanagari* under the same file names.)
