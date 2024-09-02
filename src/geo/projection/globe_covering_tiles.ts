import {vec2} from 'gl-matrix';
import {IntersectionResult} from '../../util/primitives';
import {CoveringTilesOptions, IReadonlyTransform, ITileVisibilityProvider} from '../transform_interface';
import {OverscaledTileID} from '../../source/tile_id';
import {MercatorCoordinate} from '../mercator_coordinate';

/**
 * Computes distance of a point to a tile in an arbitrary axis.
 * World is assumed to have size 1, distance returned is to the nearer tile edge.
 * @param point - Point position.
 * @param tile - Tile position.
 * @param tileSize - Tile size.
 */
function distanceToTileSimple(point: number, tile: number, tileSize: number): number {
    const delta = point - tile;
    return (delta < 0) ? -delta : Math.max(0, delta - tileSize);
}

function distanceToTileWrapX(pointX: number, pointY: number, tileCornerX: number, tileCornerY: number, tileSize: number): number {
    const tileCornerToPointX = pointX - tileCornerX;

    let distanceX: number;
    if (tileCornerToPointX < 0) {
        // Point is left of tile
        distanceX = Math.min(-tileCornerToPointX, 1.0 + tileCornerToPointX - tileSize);
    } else if (tileCornerToPointX > 1) {
        // Point is right of tile
        distanceX = Math.min(Math.max(tileCornerToPointX - tileSize, 0), 1.0 - tileCornerToPointX);
    } else {
        // Point is inside tile in the X axis.
        distanceX = 0;
    }

    return Math.max(distanceX, distanceToTileSimple(pointY, tileCornerY, tileSize));
}

/**
 * Returns the distance of a point to a square tile. If the point is inside the tile, returns 0.
 * Assumes the world to be of size 1.
 * Handles distances on a sphere correctly: X is wrapped when crossing the antimeridian,
 * when crossing the poles Y is mirrored and X is shifted by half world size.
 */
function distanceToTile(pointX: number, pointY: number, tileCornerX: number, tileCornerY: number, tileSize: number): number {
    const worldSize = 1.0;
    const halfWorld = 0.5 * worldSize;
    let smallestDistance = 2.0 * worldSize;
    // Original tile
    smallestDistance = Math.min(smallestDistance, distanceToTileWrapX(pointX, pointY, tileCornerX, tileCornerY, tileSize));
    // Up
    smallestDistance = Math.min(smallestDistance, distanceToTileWrapX(pointX, pointY, tileCornerX + halfWorld, -tileCornerY - tileSize, tileSize));
    // Down
    smallestDistance = Math.min(smallestDistance, distanceToTileWrapX(pointX, pointY, tileCornerX + halfWorld, worldSize + worldSize - tileCornerY - tileSize, tileSize));

    return smallestDistance;
}

/**
 * Returns a list of tiles that optimally covers the screen. Adapted for globe projection.
 * Correctly handles LOD when moving over the antimeridian.
 * @param transform - The globe transform instance.
 * @param options - Additional coveringTiles options.
 * @returns A list of tile coordinates, ordered by ascending distance from camera.
 */
export function globeCoveringTiles(transform: IReadonlyTransform & ITileVisibilityProvider, options: CoveringTilesOptions): OverscaledTileID[] {
    let z = transform.coveringZoomLevel(options);
    const actualZ = z;

    if (options.minzoom !== undefined && z < options.minzoom) {
        return [];
    }
    if (options.maxzoom !== undefined && z > options.maxzoom) {
        z = options.maxzoom;
    }

    const cameraCoord = transform.screenPointToMercatorCoordinate(transform.getCameraPoint());
    const centerCoord = MercatorCoordinate.fromLngLat(transform.center);
    const numTiles = Math.pow(2, z);
    const cameraPoint = [numTiles * cameraCoord.x, numTiles * cameraCoord.y, 0];
    const centerPoint = [numTiles * centerCoord.x, numTiles * centerCoord.y, 0];

    const radiusOfMaxLvlLodInTiles = 3;

    // Do a depth-first traversal to find visible tiles and proper levels of detail
    const stack: Array<{
        x: number;
        y: number;
        zoom: number;
        fullyVisible: boolean;
    }> = [];
    const result: Array<{
        tileID: OverscaledTileID;
        distanceSq: number;
        tileDistanceToCamera: number;
    }> = [];
    const maxZoom = z;
    const overscaledZ = options.reparseOverscaled ? actualZ : z;
    stack.push({
        zoom: 0,
        x: 0,
        y: 0,
        fullyVisible: false
    });

    while (stack.length > 0) {
        const it = stack.pop();
        const x = it.x;
        const y = it.y;
        let fullyVisible = it.fullyVisible;

        // Visibility of a tile is not required if any of its ancestor if fully visible
        if (!fullyVisible) {
            const intersectResult = transform.isTileVisible(it.x, it.y, it.zoom);

            if (intersectResult === IntersectionResult.None)
                continue;

            fullyVisible = intersectResult === IntersectionResult.Full;
        }

        // Determine whether the tile needs any further splitting.
        // At each level, we want at least `radiusOfMaxLvlLodInTiles` tiles loaded in each axis from the map center point.
        // For radiusOfMaxLvlLodInTiles=1, this would result in something like this:
        // z=4 |--------------||--------------||--------------|
        // z=5         |------||------||------|
        // z=6             |--||--||--|
        //                       ^map center
        // ...where "|--|" symbolizes a tile viewed sideways.
        // This logic might be slightly different from what mercator_transform.ts does, but should result in very similar (if not the same) set of tiles being loaded.
        const scale = 1 << (Math.max(it.zoom, 0));
        const tileSize = 1.0 / scale;
        const tileX = x / scale; // In range 0..1
        const tileY = y / scale; // In range 0..1
        const centerDist = distanceToTile(centerCoord.x, centerCoord.y, tileX, tileY, tileSize);
        const cameraDist = distanceToTile(cameraCoord.x, cameraCoord.y, tileX, tileY, tileSize);
        const split = Math.min(centerDist, cameraDist) * 2 <= radiusOfMaxLvlLodInTiles; // Multiply distance by 2, because the subdivided tiles would be half the size

        // Have we reached the target depth or is the tile too far away to be any split further?
        if (it.zoom === maxZoom || !split) {
            const dz = maxZoom - it.zoom;
            const dx = cameraPoint[0] - 0.5 - (x << dz);
            const dy = cameraPoint[1] - 0.5 - (y << dz);
            // We need to compute a valid wrap value for the tile to keep compatibility with mercator

            const distanceCurrent = distanceToTileSimple(centerCoord.x, tileX, tileSize);
            const distanceLeft = distanceToTileSimple(centerCoord.x, tileX - 1.0, tileSize);
            const distanceRight = distanceToTileSimple(centerCoord.x, tileX + 1.0, tileSize);
            const distanceSmallest = Math.min(distanceCurrent, distanceLeft, distanceRight);
            let wrap = 0;
            if (distanceSmallest === distanceLeft) {
                wrap = -1;
            }
            if (distanceSmallest === distanceRight) {
                wrap = 1;
            }
            result.push({
                tileID: new OverscaledTileID(it.zoom === maxZoom ? overscaledZ : it.zoom, wrap, it.zoom, x, y),
                distanceSq: vec2.sqrLen([centerPoint[0] - 0.5 - dx, centerPoint[1] - 0.5 - dy]),
                // this variable is currently not used, but may be important to reduce the amount of loaded tiles
                tileDistanceToCamera: Math.sqrt(dx * dx + dy * dy)
            });
            continue;
        }

        for (let i = 0; i < 4; i++) {
            const childX = (x << 1) + (i % 2);
            const childY = (y << 1) + (i >> 1);
            const childZ = it.zoom + 1;
            stack.push({zoom: childZ, x: childX, y: childY, fullyVisible});
        }
    }

    return result.sort((a, b) => a.distanceSq - b.distanceSq).map(a => a.tileID);
}