import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { devicesApi } from "../api/devices";
import CameraStreamView from "../components/CameraStreamView";

export default function CameraStreamPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const initialLens = (searchParams.get("lens") === "front" ? "front" : "back") as "front" | "back";
  const [deviceLabel, setDeviceLabel] = useState<string | undefined>(undefined);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    devicesApi
      .get(id)
      .then((d) => setDeviceLabel(d.device_label))
      .catch((err) => {
        if (err?.response?.status === 404) {
          setNotFound(true);
        }
      });
  }, [id]);

  if (!id) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-300 flex items-center justify-center p-4">
        <p className="text-sm">Device ID missing.</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-300 flex flex-col items-center justify-center p-4 text-center">
        <p className="text-base text-rose-400 font-semibold mb-2">Device Not Found</p>
        <p className="text-sm text-slate-400 max-w-md mb-4">
          Device ID <code className="text-slate-200">{id}</code> does not exist on this server. This device may have been removed or created on a different instance.
        </p>
        <button
          onClick={() => window.close()}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-sm transition"
        >
          Close Window
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center overflow-x-hidden">
      <CameraStreamView
        deviceId={id}
        deviceName={deviceLabel}
        initialLens={initialLens}
        isStandalone={true}
        onClose={() => window.close()}
      />
    </div>
  );
}
