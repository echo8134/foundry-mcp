// The regions of a scene: what get_scene says of one.

import { shapeInFrame } from "./region-data.mjs";
import { systemAsRead } from "./region-references.mjs";
import { isManaged } from "./scope.mjs";

/**
 * What get_scene says of a region, from its stored data (common/documents/region.mjs:48-90): the shapes in the frame,
 * an elevation without a bound as null, a restriction only while it is enabled and an attachment only to a token.
 * Left out is what places no region and decides nothing in play: the lock and the highlighting of the region layer,
 * the ownership, and the shape constraints Foundry works out itself.
 */
export function regionFields(region, frame, rect) {
  const { name, color, shapes, elevation, levels, restriction, attachment, visibility, hidden } = region._source;
  return {
    id: region.id,
    name,
    levels: [...levels],
    elevation: { ...elevation },
    shapes: shapes.map((shape) => shapeInFrame(shape, frame, rect)),
    color,
    visibility,
    hidden,
    ...(restriction.enabled && { restriction: { ...restriction } }),
    ...(attachment.token && { attachment: { token: attachment.token } }),
    behaviors: region.behaviors.map((behavior) => ({
      id: behavior.id,
      type: behavior.type,
      name: behavior.name,
      disabled: behavior.disabled,
      system: systemAsRead(behavior),
      managed: isManaged(behavior)
    })),
    managed: isManaged(region)
  };
}
