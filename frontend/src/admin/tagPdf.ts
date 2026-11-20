import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

export type TagSheet = { id: number; path: string };

const points = (millimeters: number) => millimeters * 72 / 25.4;

export async function createTagPdf(sheets: TagSheet[], widthMm: number, heightMm: number, sideMm: number) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(sheets.length === 1 ? 'AprilTag ' + sheets[0].id : 'AprilTags · ' + sheets.length);
  const width = points(widthMm), height = points(heightMm);
  const sizeLabel = sideMm.toLocaleString('ko-KR', { maximumFractionDigits: 4 });

  for (const sheet of sheets) {
    const page = pdf.addPage([width, height]);
    function centered(text: string, fromTopMm: number, fontSizeMm: number, font: PDFFont = regular) {
      const size = points(fontSizeMm);
      page.drawText(text, {
        x: (width - font.widthOfTextAtSize(text, size)) / 2,
        y: height - points(fromTopMm), size, font,
      });
    }
    centered('AprilTag · ID ' + sheet.id, 16, 7, bold);
    centered('tag36h11 · Black edge ' + sizeLabel + ' mm', 24, 3.8);
    const upBaseline = (heightMm - sideMm * 1.25) / 2 - 4;
    centered('UP', upBaseline, 4);
    page.drawSvgPath('M0 3V0m-1.1 1.2L0 0l1.1 1.2', {
      x: width / 2 - points(5), y: height - points(upBaseline - 3), scale: points(1),
      borderColor: rgb(0, 0, 0), borderWidth: .25,
    });
    page.drawSvgPath(sheet.path, {
      x: (width - points(sideMm)) / 2, y: (height + points(sideMm)) / 2,
      scale: points(sideMm / 8), color: rgb(0, 0, 0),
    });
    page.drawSvgPath('M0 -2v4m0 -2h100m0 -2v4', {
      x: (width - points(100)) / 2, y: points(17), scale: points(1),
      borderColor: rgb(0, 0, 0), borderWidth: .25,
    });
    centered('100 mm', heightMm - 10, 3.5);
  }

  const bytes = await pdf.save();
  return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
}
