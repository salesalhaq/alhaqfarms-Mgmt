"use client";

import Image from "next/image";
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/business-settings";
import { useOptionalBusinessSettings } from "@/components/BusinessSettingsProvider";

export function BrandLockup({ className = "" }: { className?: string }) {
  const businessSettings = useOptionalBusinessSettings();
  const businessName = businessSettings?.settings.businessName || DEFAULT_BUSINESS_SETTINGS.businessName;
  const businessTagline = businessSettings?.settings.businessTagline || DEFAULT_BUSINESS_SETTINGS.businessTagline;
  const logo = businessSettings?.settings.logoDataUrl || "/brand-mark.png";

  return (
    <div className={`brand-lockup ${className}`.trim()}>
      <Image
        className="brand-mark-image"
        src={logo}
        alt={`${businessName} logo`}
        width={48}
        height={48}
        priority
        unoptimized={logo.startsWith("data:")}
      />
      <div className="brand-copy">
        <strong>{businessName}</strong>
        {businessTagline && <small>{businessTagline}</small>}
      </div>
    </div>
  );
}
