import Image from "next/image";

export function BrandLockup({ className = "" }: { className?: string }) {
  return (
    <div className={`brand-lockup ${className}`.trim()}>
      <Image
        className="brand-mark-image"
        src="/brand-mark.png"
        alt="Al Haq Farms & Meats logo"
        width={48}
        height={48}
        priority
      />
      <div className="brand-copy">
        <strong>Al Haq Farms &amp; Meats</strong>
        <small>Pure.Fresh.Perfected.</small>
      </div>
    </div>
  );
}
