import {LngLatBounds, LngLatBoundsLike} from '../geo/lng_lat_bounds';
import {mercatorXfromLng, mercatorYfromLat} from '../geo/mercator_coordinate';
import {mod} from '../util/util';

import type {CanonicalTileID} from './tile_id';

function fract(x: number): number {
    return x - Math.floor(x);
}

export class TileBounds {
    /**
     * Coordinate bounds. Longitude is *not* clamped to [-180, 180]!
     */
    bounds: LngLatBounds;
    minzoom: number;
    maxzoom: number;

    constructor(bounds: [number, number, number, number], minzoom?: number | null, maxzoom?: number | null) {
        this.bounds = LngLatBounds.convert(this.validateBounds(bounds));
        this.minzoom = minzoom || 0;
        this.maxzoom = maxzoom || 24;
    }

    validateBounds(bounds: [number, number, number, number]): LngLatBoundsLike {
        // make sure the bounds property contains valid longitude and latitudes
        if (!Array.isArray(bounds) || bounds.length !== 4) return [-180, -90, 180, 90];
        return [bounds[0], Math.max(-90, bounds[1]), bounds[2], Math.min(90, bounds[3])];
    }

    contains(tileID: CanonicalTileID) {
        const worldSize = Math.pow(2, tileID.z);

        // Latitude test
        const minY = Math.floor(mercatorYfromLat(this.bounds.getNorth()) * worldSize);
        const maxY = Math.ceil(mercatorYfromLat(this.bounds.getSouth()) * worldSize);

        if (tileID.y < minY || tileID.y >= maxY) {
            return false;
        }

        // Longitude test with wrapping around the globe
        let minX = fract(mercatorXfromLng(this.bounds.getWest()));
        let maxX = fract(mercatorXfromLng(this.bounds.getEast()));
        if (minX >= maxX) {
            maxX += 1;
        }
        minX = Math.floor(minX * worldSize);
        maxX = Math.ceil(maxX * worldSize);

        const wrappedTileX = mod(tileID.x, worldSize);
        return (wrappedTileX >= minX && wrappedTileX < maxX) || (wrappedTileX + worldSize >= minX && wrappedTileX + worldSize < maxX);
    }
}
