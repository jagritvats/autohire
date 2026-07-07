// pdf-parse ships types for its main entry only. We import the lib subpath directly
// (`pdf-parse/lib/pdf-parse.js`) to skip the package's require-time debug shim that
// reads a bundled test PDF. Declare the subpath so TS is happy.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
