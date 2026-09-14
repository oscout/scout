import { useId } from "react";
import woodland from "./assets/adventure-habitats-v1.png?url";

/** Alternate mirrored tiles meet at identical image edges without an abrupt seam. */
export function AdventureScenery() {
  const id = useId();
  return <svg className="adventures__scenery" width="100%" height="400" aria-hidden="true">
    <defs><pattern id={id} width="2400" height="400" patternUnits="userSpaceOnUse">
      <image href={woodland} width="1200" height="400" preserveAspectRatio="none"/>
      <image href={woodland} width="1200" height="400" preserveAspectRatio="none" transform="translate(2400 0) scale(-1 1)"/>
    </pattern></defs>
    <rect width="100%" height="400" fill={`url(#${id})`}/>
  </svg>;
}
