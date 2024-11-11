import {vec4} from 'gl-matrix';
import {Aabb, IBoundingPrimitive, IntersectionResult} from './aabb';
import {angularCoordinatesRadiansToVector} from '../../geo/projection/globe_utils';
import {clamp} from '../util';
import {Frustum} from './frustum';
import {tileCoordinatesToMercatorCoordinates} from '../../geo/projection/mercator_utils';
import {EXTENT} from '../../data/extent';

export class SphereTile implements IBoundingPrimitive {
    private _minLngRadians: number;
    private _maxLngRadians: number;
    private _minLatRadians: number;
    private _maxLatRadians: number;
    private _aabb: Aabb;

    constructor(tileID: {x: number; y: number; z: number}, aabb: Aabb) {
        this._aabb = aabb;
        const min = tileCoordinatesToMercatorCoordinates(0, EXTENT, tileID).toLngLat();
        const max = tileCoordinatesToMercatorCoordinates(EXTENT, 0, tileID).toLngLat();
        this._minLngRadians = min.lng * Math.PI / 180.0;
        this._minLatRadians = min.lat * Math.PI / 180.0;
        this._maxLngRadians = max.lng * Math.PI / 180.0;
        this._maxLatRadians = max.lat * Math.PI / 180.0;
    }

    /**
     * Performs a frustum-aabb intersection test.
     */
    intersectsFrustum(frustum: Frustum): IntersectionResult {
        // Execute separating axis test between two convex objects to find intersections
        // Each frustum plane together with 3 major axes define the separating axes
        let fullyInside = true;

        for (let p = 0; p < frustum.planes.length; p++) {
            const planeIntersection = this.intersectsPlane(frustum.planes[p]);

            if (planeIntersection === IntersectionResult.None) {
                return IntersectionResult.None;
            }
            if (planeIntersection === IntersectionResult.Partial) {
                fullyInside = false;
            }
        }

        if (fullyInside) {
            return IntersectionResult.Full;
        }

        if (frustum.aabb.min[0] > this._aabb.max[0] || frustum.aabb.min[1] > this._aabb.max[1] || frustum.aabb.min[2] > this._aabb.max[2] ||
            frustum.aabb.max[0] < this._aabb.min[0] || frustum.aabb.max[1] < this._aabb.min[1] || frustum.aabb.max[2] < this._aabb.min[2]) {
            return IntersectionResult.None;
        }

        return IntersectionResult.Partial;
    }

    /**
     * Performs a halfspace-tile intersection test.
     */
    public intersectsPlane(plane: vec4): IntersectionResult {
        /*
        We know the lng and lat range this tile covers.
        For a given sphere point in this tile:

        vec[0] = sin(lng) * cos(lat);
        vec[1] = sin(lat);
        vec[2] = cos(lng) * cos(lat);

        The distance from plane "p" is equal to:

        dist = sin(lng) * cos(lat) * p[0] + sin(lat) * p[1] + cos(lng) * cos(lat) * p[2] + p[3]

        We want to find the lng,lat that will maximize or minimize dist.
        Omitting p[3] (since it is irrelevant to finding the extremes),
        we can rewrite the above to:

        dist = (sin(lng) * p[0] + cos(lng) * p[2]) * cos(lat) + sin(lat) * p[1]

        From this it is apparent that we can find the extremes for lng separately, using the derivative of "sin(lng) * p[0] + cos(lng) * p[2]":

        lng = PI*n + atan(p[0] / p[2])
            where n is any integer
        
        We can now compute "L" as the value of "sin(lng) * p[0] + cos(lng) * p[2]" for both possible lng extremes.
        Note that we don't know which extreme of lng is the maximum, since it is later multiplied by cos(lat), the value of which is so far unknown.
        Plugging L into the distance calculation:

        dist = L * cos(lat) + sin(lat) * p[1]
        
        */

        const lngA = Math.atan(plane[0] / plane[2]);
        const lngB = lngA + lngA < 0 ? Math.PI : -Math.PI;
        const lngAclamped = clampLngRadians(lngA, this._minLngRadians, this._maxLngRadians);
        const lngBclamped = clampLngRadians(lngB, this._minLngRadians, this._maxLngRadians);

        const latA = Math.atan(plane[1] / lngAclamped);
        const latB = Math.atan(plane[1] / lngBclamped);
        const latA0clamped = clamp(latA, this._minLatRadians, this._maxLatRadians);
        const latA1clamped = clamp(latA > this._maxLatRadians ? latA - Math.PI : latA + Math.PI, this._minLatRadians, this._maxLatRadians);
        const latB0clamped = clamp(latB, this._minLatRadians, this._maxLatRadians);
        const latB1clamped = clamp(latB > this._maxLatRadians ? latB - Math.PI : latB + Math.PI, this._minLatRadians, this._maxLatRadians);

        const vecA0 = angularCoordinatesRadiansToVector(lngAclamped, latA0clamped);
        const vecA1 = angularCoordinatesRadiansToVector(lngAclamped, latA1clamped);
        const vecB0 = angularCoordinatesRadiansToVector(lngBclamped, latB0clamped);
        const vecB1 = angularCoordinatesRadiansToVector(lngBclamped, latB1clamped);

        const distA0 = vecA0[0] * plane[0] + vecA0[1] * plane[1] + vecA0[2] * plane[2] + plane[3];
        const distA1 = vecA1[0] * plane[0] + vecA1[1] * plane[1] + vecA1[2] * plane[2] + plane[3];
        const distB0 = vecB0[0] * plane[0] + vecB0[1] * plane[1] + vecB0[2] * plane[2] + plane[3];
        const distB1 = vecB1[0] * plane[0] + vecB1[1] * plane[1] + vecB1[2] * plane[2] + plane[3];
        
        const min = Math.min(distA0, distA1, distB0, distB1);
        const max = Math.max(distA0, distA1, distB0, distB1);

        if (min >= 0) {
            return IntersectionResult.Full;
        }
        if (max < 0) {
            return IntersectionResult.None;
        }
        return IntersectionResult.Partial;
    }
}

/**
 * Clamps longitude in radians to the given range on a circle. Assumes all three input values to be in the same range (eg. -Pi..PI or 0..2PI).
 */
function clampLngRadians(lng: number, min: number, max: number): number {
    if (lng < min) {
        if (min - lng < lng + 2 * Math.PI - max) {
            return min;
        } else {
            return max;
        }
    } else if (lng > max) {
        if (lng - max < min - lng - 2 * Math.PI) {
            return max;
        } else {
            return min;
        }
    } else {
        return lng;
    }
}
