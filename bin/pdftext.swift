// pdftext: print the text of a PDF, page by page (uses Apple's PDFKit)
import Foundation
import PDFKit
let args = CommandLine.arguments
guard args.count >= 2, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write("cannot open PDF\n".data(using: .utf8)!); exit(1)
}
let first = args.count > 2 ? max(1, Int(args[2]) ?? 1) : 1
let last = args.count > 3 ? min(doc.pageCount, Int(args[3]) ?? doc.pageCount) : doc.pageCount
print("[\(doc.pageCount) pages]")
if first <= last {
    for i in (first - 1)..<last {
        print("\n--- page \(i + 1) ---")
        print(doc.page(at: i)?.string ?? "")
    }
}
