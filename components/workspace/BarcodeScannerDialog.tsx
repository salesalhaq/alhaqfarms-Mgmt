"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface CameraLikeError {
  name?: string;
  message?: string;
}

function cameraErrorMessage(error: CameraLikeError): string {
  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Camera access was blocked. Allow camera permission for this site in your browser settings, then reopen the scanner. Camera access requires HTTPS or localhost.";
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "No camera was found. Connect or enable a camera, then try again.";
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError" || error.name === "AbortError") {
    return "The camera could not start. Close other apps using the camera and check that the camera is enabled.";
  }
  if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") {
    return "The selected camera is unavailable. Choose another camera and try again.";
  }
  return error.message || "Unable to access the camera.";
}

/**
 * Camera barcode scanner. Mirrors the desktop `BarcodeScanner` component but
 * uses the already-installed `@zxing/library` build of the multi-format reader.
 */
export function BarcodeScannerDialog({
  open,
  onClose,
  onDetected,
}: {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanHandledRef = useRef(false);
  const [error, setError] = useState("");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [starting, setStarting] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!open || !videoRef.current) return undefined;
    let active = true;
    let reader: { decodeFromStream: (stream: MediaStream, video: HTMLVideoElement, callback: (result: { getText: () => string } | null) => void) => Promise<void>; reset: () => void } | null = null;
    let stream: MediaStream | null = null;
    const video = videoRef.current;
    scanHandledRef.current = false;
    setError("");
    setStarting(true);

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is unavailable. Open this app over HTTPS or localhost and use a browser that supports camera access.");
      }
      const videoConstraints: MediaTrackConstraints = selectedCameraId
        ? { deviceId: { exact: selectedCameraId } }
        : { facingMode: { ideal: facingMode } };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      } catch (cameraError) {
        const name = (cameraError as CameraLikeError).name || "";
        if (!selectedCameraId || !["NotFoundError", "OverconstrainedError", "DevicesNotFoundError", "ConstraintNotSatisfiedError"].includes(name)) {
          throw cameraError;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode } },
          audio: false,
        });
      }
      if (!active) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const activeCameraId = stream.getVideoTracks()[0]?.getSettings().deviceId || "";
      const listedCameras = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = listedCameras.filter((device) => device.kind === "videoinput");
      if (active) {
        setCameras(videoInputs);
        if (activeCameraId && activeCameraId !== selectedCameraId) setSelectedCameraId(activeCameraId);
      }

      const { BrowserMultiFormatReader } = await import("@zxing/library");
      const codeReader = new BrowserMultiFormatReader();
      reader = codeReader;
      await codeReader.decodeFromStream(stream, video, (result) => {
        if (!active || !result || scanHandledRef.current) return;
        scanHandledRef.current = true;
        active = false;
        codeReader.reset();
        stream?.getTracks().forEach((track) => track.stop());
        onDetected(result.getText());
        onClose();
      });
      if (!active) codeReader.reset();
    };

    start()
      .catch((cameraError: CameraLikeError) => {
        if (active) {
          reader?.reset();
          stream?.getTracks().forEach((track) => track.stop());
          if (video) video.srcObject = null;
          setError(cameraErrorMessage(cameraError));
        }
      })
      .finally(() => {
        if (active) setStarting(false);
      });

    return () => {
      active = false;
      reader?.reset();
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, [open, selectedCameraId, facingMode, retryCount, onClose, onDetected]);

  const switchFacing = () => {
    setSelectedCameraId("");
    setFacingMode((current) => (current === "environment" ? "user" : "environment"));
  };

  if (!open) return null;

  return (
    <div
      className="sales-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section aria-labelledby="pos-scanner-title" aria-modal="true" className="sales-dialog card" role="dialog">
        <div className="sales-dialog-header">
          <div>
            <p className="eyebrow page">POS</p>
            <h2 id="pos-scanner-title">Scan barcode</h2>
          </div>
          <button aria-label="Close barcode scanner" className="button secondary" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <video ref={videoRef} className="pos-scanner-video" muted playsInline autoPlay />
        <div className="pos-scanner-controls">
          {cameras.length > 1 && (
            <label className="field">
              <span>Camera</span>
              <select
                aria-label="Select camera"
                value={selectedCameraId}
                onChange={(event) => setSelectedCameraId(event.target.value)}
              >
                {cameras.map((camera, index) => (
                  <option key={camera.deviceId || index} value={camera.deviceId}>
                    {camera.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="secondary-button" disabled={starting} onClick={switchFacing} type="button">
            Switch front / back
          </button>
          {error && (
            <button className="secondary-button" disabled={starting} onClick={() => setRetryCount((count) => count + 1)} type="button">
              Try again
            </button>
          )}
        </div>
        <p className="pos-scanner-help">
          {starting
            ? "Starting camera…"
            : "Allow camera permission when asked. On phones and tablets, use Switch front / back or choose a camera."}
        </p>
        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>
    </div>
  );
}
