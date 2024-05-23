import {mat4, vec3, vec4} from 'gl-matrix';
import {Transform} from '../transform';
import {Tile} from '../../source/tile';
import {translatePosition} from './mercator_transform';
import {LngLat, earthRadius} from '../lng_lat';
import {EXTENT} from '../../data/extent';
import {easeCubicInOut, lerp, mod} from '../../util/util';
import {UnwrappedTileID} from '../../source/tile_id';
import Point from '@mapbox/point-geometry';
import {browser} from '../../util/browser';
import {Terrain} from '../../render/terrain';

export class GlobeTransform extends Transform {
    private _cachedClippingPlane: vec4 = [1, 0, 0, 0];

    // Transition handling
    private _lastGlobeStateEnabled: boolean = true;

    private _lastLargeZoomStateChange: number = -1000.0;
    private _lastLargeZoomState: boolean = false;

    private _skipNextAnimation: boolean = true;

    private _globeProjMatrix: mat4 = mat4.create();
    private _globeProjMatrixNoCorrection: mat4 = mat4.create();
    private _globeProjMatrixNoCorrectionInverted: mat4 = mat4.create();

    private _cameraPosition: vec3 = [0, 0, 0];

    private _oldTransformState: {zoom: number; lat: number} = undefined;

    private _lastGlobeChangeTime: number = -1000.0;
    private _globeProjectionOverride = true;

    get cameraPosition(): vec3 {
        return vec3.clone(this._cameraPosition); // Return a copy - don't let outside code mutate our precomputed camera position.
    }

    /**
     * Returns whether globe view is allowed.
     * When allowed, globe fill function as normal, displaying a 3D planet,
     * but transitioning to mercator at high zoom levels.
     * Otherwise, mercator will be used at all zoom levels instead.
     * Set with {@link setGlobeViewAllowed}.
     */
    public getGlobeViewAllowed(): boolean {
        return this._globeProjectionOverride;
    }

    /**
     * Sets whether globe view is allowed. When allowed, globe fill function as normal, displaying a 3D planet,
     * but transitioning to mercator at high zoom levels.
     * Otherwise, mercator will be used at all zoom levels instead.
     * @param allow - Sets whether glove view is allowed.
     * @param animateTransition - Controls whether the transition between globe view and mercator (if triggered by this call) should be animated. True by default.
     */
    public setGlobeViewAllowed(allow: boolean, animateTransition: boolean = true) {
        if (!animateTransition && allow !== this._globeProjectionOverride) {
            this._skipNextAnimation = true;
        }
        this._globeProjectionOverride = allow;
    }

    private _getZoomAdjustment(oldLat: number, newLat: number): number {
        const oldCircumference = Math.cos(oldLat * Math.PI / 180.0);
        const newCircumference = Math.cos(newLat * Math.PI / 180.0);
        return Math.log2(newCircumference / oldCircumference);
    }

    public translatePosition(tile: Tile, translate: [number, number], translateAnchor: 'map' | 'viewport'): [number, number] {
        // In the future, some better translation for globe and other weird projections should be implemented here,
        // especially for the translateAnchor==='viewport' case.
        return translatePosition(this, tile, translate, translateAnchor);
    }

    public updateProjection(): void {
        this._mercator.updateProjection(transform);

        if (this._oldTransformState) {
            if (this.useGlobeControls) {
                transform.zoom += this._getZoomAdjustment(this._oldTransformState.lat, transform.center.lat);
            }
            this._oldTransformState.zoom = transform.zoom;
            this._oldTransformState.lat = transform.center.lat;
        } else {
            this._oldTransformState = {
                zoom: transform.zoom,
                lat: transform.center.lat
            };
        }

        this._errorQueryLatitudeDegrees = transform.center.lat;
        this._updateAnimation(transform.zoom);

        // We want zoom levels to be consistent between globe and flat views.
        // This means that the pixel size of features at the map center point
        // should be the same for both globe and flat view.
        const globeRadiusPixels = transform.worldSize / (2.0 * Math.PI) / Math.cos(transform.center.lat * Math.PI / 180);

        // Construct a completely separate matrix for globe view
        const globeMatrix = new Float64Array(16) as any;
        const globeMatrixUncorrected = new Float64Array(16) as any;
        mat4.perspective(globeMatrix, transform.fov * Math.PI / 180, transform.width / transform.height, 0.5, transform.cameraToCenterDistance + globeRadiusPixels * 2.0); // just set the far plane far enough - we will calculate our own z in the vertex shader anyway
        mat4.translate(globeMatrix, globeMatrix, [0, 0, -transform.cameraToCenterDistance]);
        mat4.rotateX(globeMatrix, globeMatrix, -transform.pitch * Math.PI / 180);
        mat4.rotateZ(globeMatrix, globeMatrix, -transform.angle);
        mat4.translate(globeMatrix, globeMatrix, [0.0, 0, -globeRadiusPixels]);
        // Rotate the sphere to center it on viewed coordinates

        // Keep a atan-correction-free matrix for transformations done on the CPU with accurate math
        mat4.rotateX(globeMatrixUncorrected, globeMatrix, transform.center.lat * Math.PI / 180.0);
        mat4.rotateY(globeMatrixUncorrected, globeMatrixUncorrected, -transform.center.lng * Math.PI / 180.0);
        mat4.scale(globeMatrixUncorrected, globeMatrixUncorrected, [globeRadiusPixels, globeRadiusPixels, globeRadiusPixels]); // Scale the unit sphere to a sphere with diameter of 1
        this._globeProjMatrixNoCorrection = globeMatrix;

        mat4.rotateX(globeMatrix, globeMatrix, transform.center.lat * Math.PI / 180.0 - this._errorCorrectionUsable);
        mat4.rotateY(globeMatrix, globeMatrix, -transform.center.lng * Math.PI / 180.0);
        mat4.scale(globeMatrix, globeMatrix, [globeRadiusPixels, globeRadiusPixels, globeRadiusPixels]); // Scale the unit sphere to a sphere with diameter of 1
        this._globeProjMatrix = globeMatrix;

        mat4.invert(this._globeProjMatrixNoCorrectionInverted, globeMatrix);

        const cameraPos: vec4 = [0, 0, -1, 1];
        vec4.transformMat4(cameraPos, cameraPos, this._globeProjMatrixNoCorrectionInverted);
        this._cameraPosition = [
            cameraPos[0] / cameraPos[3],
            cameraPos[1] / cameraPos[3],
            cameraPos[2] / cameraPos[3]
        ];

        this._cachedClippingPlane = this._computeClippingPlane(transform, globeRadiusPixels);
    }

    private _updateAnimation(currentZoom: number) {
        // Update globe transition animation
        const globeState = this._globeProjectionOverride;
        const currentTime = browser.now();
        if (globeState !== this._lastGlobeStateEnabled) {
            this._lastGlobeChangeTime = currentTime;
            this._lastGlobeStateEnabled = globeState;
        }
        // Transition parameter, where 0 is the start and 1 is end.
        const globeTransition = Math.min(Math.max((currentTime - this._lastGlobeChangeTime) / 1000.0 / globeTransitionTimeSeconds, 0.0), 1.0);
        this._globeness = globeState ? globeTransition : (1.0 - globeTransition);

        if (this._skipNextAnimation) {
            this._globeness = globeState ? 1.0 : 0.0;
            this._lastGlobeChangeTime = currentTime - globeTransitionTimeSeconds * 1000.0 * 2.0;
            this._skipNextAnimation = false;
        }

        // Update globe zoom transition
        const currentZoomState = currentZoom >= maxGlobeZoom;
        if (currentZoomState !== this._lastLargeZoomState) {
            this._lastLargeZoomState = currentZoomState;
            this._lastLargeZoomStateChange = currentTime;
        }
        const zoomTransition = Math.min(Math.max((currentTime - this._lastLargeZoomStateChange) / 1000.0 / zoomTransitionTimeSeconds, 0.0), 1.0);
        const zoomGlobenessBound = currentZoomState ? (1.0 - zoomTransition) : zoomTransition;
        this._globeness = Math.min(this._globeness, zoomGlobenessBound);
        this._globeness = easeCubicInOut(this._globeness); // Smooth animation
    }

    override isRenderingDirty(): boolean {
        const now = browser.now();
        let dirty = false;
        // Globe transition
        dirty = dirty || (now - this._lastGlobeChangeTime) / 1000.0 < (Math.max(globeConstants.globeTransitionTimeSeconds, globeConstants.zoomTransitionTimeSeconds) + 0.2);
        // Error correction transition
        dirty = dirty || (now - this._errorMeasurementLastChangeTime) / 1000.0 < (globeConstants.errorTransitionTimeSeconds + 0.2);
        // Error correction query in flight
        dirty = dirty || this._errorMeasurement.awaitingQuery;
        return dirty;
    }

    override getProjectionData(overscaledTileID: OverscaledTileID, tilePosMatrix?: mat4, useAtanCorrection: boolean = true): ProjectionData {
        const data = this._mercator.getProjectionData(overscaledTileID, tilePosMatrix);

        // Set 'u_projection_matrix' to actual globe transform
        if (this.useGlobeRendering) {
            data['u_projection_matrix'] = useAtanCorrection ? this._globeProjMatrix : this._globeProjMatrixNoCorrection;
        }

        data['u_projection_clipping_plane'] = this._cachedClippingPlane as [number, number, number, number];
        data['u_projection_transition'] = this._globeness;

        return data;
    }

    private _computeClippingPlane(
        transform: { center: LngLat; pitch: number; angle: number; cameraToCenterDistance: number },
        globeRadiusPixels: number
    ): vec4 {
        // We want to compute a plane equation that, when applied to the unit sphere generated
        // in the vertex shader, places all visible parts of the sphere into the positive half-space
        // and all the non-visible parts in the negative half-space.
        // We can then use that to accurately clip all non-visible geometry.

        // cam....------------A
        //        ....        |
        //            ....    |
        //                ....B
        //                ggggggggg
        //          gggggg    |   .gggggg
        //       ggg          |       ...ggg    ^
        //     gg             |                 |
        //    g               |                 y
        //    g               |                 |
        //   g                C                 #---x--->
        //
        // Notes:
        // - note the coordinate axes
        // - "g" marks the globe edge
        // - the dotted line is the camera center "ray" - we are looking in this direction
        // - "cam" is camera origin
        // - "C" is globe center
        // - "B" is the point on "top" of the globe - camera is looking at B - "B" is the intersection between the camera center ray and the globe
        // - this._pitch is the angle at B between points cam,B,A
        // - this.cameraToCenterDistance is the distance from camera to "B"
        // - globe radius is (0.5 * this.worldSize)
        // - "T" is any point where a tangent line from "cam" touches the globe surface
        // - elevation is assumed to be zero - globe rendering must be separate from terrain rendering anyway

        const pitch = transform.pitch * Math.PI / 180.0;
        // scale things so that the globe radius is 1
        const distanceCameraToB = transform.cameraToCenterDistance / globeRadiusPixels;
        const radius = 1;

        // Distance from camera to "A" - the point at the same elevation as camera, right above center point on globe
        const distanceCameraToA = Math.sin(pitch) * distanceCameraToB;
        // Distance from "A" to "C"
        const distanceAtoC = (Math.cos(pitch) * distanceCameraToB + radius);
        // Distance from camera to "C" - the globe center
        const distanceCameraToC = Math.sqrt(distanceCameraToA * distanceCameraToA + distanceAtoC * distanceAtoC);
        // cam - C - T angle cosine (at C)
        const camCTcosine = radius / distanceCameraToC;
        // Distance from globe center to the plane defined by all possible "T" points
        const tangentPlaneDistanceToC = camCTcosine * radius;

        let vectorCtoCamX = -distanceCameraToA;
        let vectorCtoCamY = distanceAtoC;
        // Normalize the vector
        const vectorCtoCamLength = Math.sqrt(vectorCtoCamX * vectorCtoCamX + vectorCtoCamY * vectorCtoCamY);
        vectorCtoCamX /= vectorCtoCamLength;
        vectorCtoCamY /= vectorCtoCamLength;

        // Note the swizzled components
        const planeVector: vec3 = [0, vectorCtoCamX, vectorCtoCamY];
        // Apply transforms - lat, lng and angle (NOT pitch - already accounted for, as it affects the tangent plane)
        vec3.rotateZ(planeVector, planeVector, [0, 0, 0], transform.angle);
        vec3.rotateX(planeVector, planeVector, [0, 0, 0], -1 * transform.center.lat * Math.PI / 180.0);
        vec3.rotateY(planeVector, planeVector, [0, 0, 0], transform.center.lng * Math.PI / 180.0);
        // Scale the plane vector up
        // we don't want the actually visible parts of the sphere to end up beyond distance 1 from the plane - otherwise they would be clipped by the near plane.
        const scale = 0.25;
        vec3.scale(planeVector, planeVector, scale);
        return [...planeVector, -tangentPlaneDistanceToC * scale];
    }

    /**
     * Returns mercator coordinates in range 0..1 for given coordinates inside a tile and the tile's canonical ID.
     */
    private _tileCoordinatesToMercatorCoordinates(inTileX: number, inTileY: number, tileID: UnwrappedTileID): [number, number] {
        const scale = 1.0 / (1 << tileID.canonical.z);
        return [
            inTileX / EXTENT * scale + tileID.canonical.x * scale,
            inTileY / EXTENT * scale + tileID.canonical.y * scale
        ];
    }

    /**
     * For given mercator coordinates in range 0..1, returns the angular coordinates on the sphere's surface, in radians.
     */
    private _mercatorCoordinatesToAngularCoordinates(mercatorX: number, mercatorY: number): [number, number] {
        const sphericalX = mod(mercatorX * Math.PI * 2.0 + Math.PI, Math.PI * 2);
        const sphericalY = 2.0 * Math.atan(Math.exp(Math.PI - (mercatorY * Math.PI * 2.0))) - Math.PI * 0.5;
        return [sphericalX, sphericalY];
    }

    private _angularCoordinatesToVector(lngRadians: number, latRadians: number): vec3 {
        const len = Math.cos(latRadians);
        return [
            Math.sin(lngRadians) * len,
            Math.sin(latRadians),
            Math.cos(lngRadians) * len
        ];
    }

    /**
     * Given a 3D point on the surface of a unit sphere, returns its angular coordinates in degrees.
     */
    private _sphereSurfacePointToCoordinates(surface: vec3): LngLat {
        const latRadians = Math.asin(surface[1]);
        const latDegrees = latRadians / Math.PI * 180.0;
        const lengthXZ = Math.sqrt(surface[0] * surface[0] + surface[2] * surface[2]);
        if (lengthXZ > 1e-6) {
            const projX = surface[0] / lengthXZ;
            const projZ = surface[2] / lengthXZ;
            const acosZ = Math.acos(projZ);
            const lngRadians = (projX > 0) ? acosZ : -acosZ;
            const lngDegrees = lngRadians / Math.PI * 180.0;
            return new LngLat(lngDegrees, latDegrees);
        } else {
            return new LngLat(0.0, latDegrees);
        }
    }

    private _projectTileCoordinatesToSphere(inTileX: number, inTileY: number, tileID: UnwrappedTileID): vec3 {
        const mercator = this._tileCoordinatesToMercatorCoordinates(inTileX, inTileY, tileID);
        const angular = this._mercatorCoordinatesToAngularCoordinates(mercator[0], mercator[1]);
        const sphere = this._angularCoordinatesToVector(angular[0], angular[1]);
        return sphere;
    }

    public isOccluded(x: number, y: number, unwrappedTileID: UnwrappedTileID): boolean {
        const spherePos = this._projectTileCoordinatesToSphere(x, y, unwrappedTileID);

        const plane = this._cachedClippingPlane;
        // dot(position on sphere, occlusion plane equation)
        const dotResult = plane[0] * spherePos[0] + plane[1] * spherePos[1] + plane[2] * spherePos[2] + plane[3];
        return dotResult < 0.0;
    }

    public transformLightDirection(dir: vec3): vec3 {
        const sphereX = this._center.lng * Math.PI / 180.0;
        const sphereY = this._center.lat * Math.PI / 180.0;

        const len = Math.cos(sphereY);
        const spherePos: vec3 = [
            Math.sin(sphereX) * len,
            Math.sin(sphereY),
            Math.cos(sphereX) * len
        ];

        const axisRight: vec3 = [spherePos[2], 0.0, -spherePos[0]]; // Equivalent to cross(vec3(0.0, 1.0, 0.0), vec)
        const axisDown: vec3 = [0, 0, 0];
        vec3.cross(axisDown, axisRight, spherePos);
        vec3.normalize(axisRight, axisRight);
        vec3.normalize(axisDown, axisDown);

        const transformed: vec3 = [
            axisRight[0] * dir[0] + axisDown[0] * dir[1] + spherePos[0] * dir[2],
            axisRight[1] * dir[0] + axisDown[1] * dir[1] + spherePos[1] * dir[2],
            axisRight[2] * dir[0] + axisDown[2] * dir[1] + spherePos[2] * dir[2]
        ];

        const normalized: vec3 = [0, 0, 0];
        vec3.normalize(normalized, transformed);
        return normalized;
    }

    public getPixelScale(): number {
        const globePixelScale = 1.0 / Math.cos(this._center.lat * Math.PI / 180);
        const flatPixelScale = 1.0;
        if (this.useGlobeRendering) {
            return lerp(flatPixelScale, globePixelScale, this._globeness);
        }
        return flatPixelScale;
    }

    public getCircleRadiusCorrection(): number {
        return Math.cos(this._center.lat * Math.PI / 180);
    }

    public getPitchedTextCorrection(textAnchor: Point, tileID: UnwrappedTileID): number {
        if (!this.useGlobeRendering) {
            return 1.0;
        }
        const mercator = this._tileCoordinatesToMercatorCoordinates(textAnchor.x, textAnchor.y, tileID);
        const angular = this._mercatorCoordinatesToAngularCoordinates(mercator[0], mercator[1]);
        return this.getCircleRadiusCorrection() / Math.cos(angular[1]);
    }

    public projectTileCoordinates(x: number, y: number, unwrappedTileID: UnwrappedTileID, getElevation: (x: number, y: number) => number) {
        if (!this.useGlobeRendering) {
            return this._mercator.projectTileCoordinates(x, y, unwrappedTileID, getElevation);
        }

        const spherePos = this._projectTileCoordinatesToSphere(x, y, unwrappedTileID);
        const elevation = getElevation ? getElevation(x, y) : 0.0;
        const vectorMultiplier = 1.0 + elevation / earthRadius;
        const pos: vec4 = [spherePos[0] * vectorMultiplier, spherePos[1] * vectorMultiplier, spherePos[2] * vectorMultiplier, 1];
        vec4.transformMat4(pos, pos, this._globeProjMatrixNoCorrection);

        // Also check whether the point projects to the backfacing side of the sphere.
        const plane = this._cachedClippingPlane;
        // dot(position on sphere, occlusion plane equation)
        const dotResult = plane[0] * spherePos[0] + plane[1] * spherePos[1] + plane[2] * spherePos[2] + plane[3];
        const isOccluded = dotResult < 0.0;

        return {
            point: new Point(pos[0] / pos[3], pos[1] / pos[3]),
            signedDistanceFromCamera: pos[3],
            isOccluded
        };
    }

    public projectScreenPoint(lnglat: LngLat, transform: Transform, terrain?: Terrain): Point {
        if (this.useGlobeControls) {
            const pos = [...this._angularCoordinatesToVector(lnglat.lng, lnglat.lat), 1] as vec4;
            vec4.transformMat4(pos, pos, this._globeProjMatrixNoCorrection);
            pos[0] /= pos[3];
            pos[1] /= pos[3];
            return new Point(
                (pos[0] * 0.5 + 0.5) * transform.width,
                (pos[1] * 0.5 + 0.5) * transform.height
            );
        } else {
            this._mercator.projectScreenPoint(lnglat, transform, terrain);
        }
    }

    // JP: TODO: unprojectExact for waypoint placement, unproject for interaction?
    public unprojectScreenPoint(p: Point, terrain?: Terrain): LngLat {
        // JP: TODO: terrain???
        if (!this.useGlobeControls) {
            return this._mercator.unprojectScreenPoint(p, transform, terrain);
        }
        const pos: vec4 = [
            ((p.x + 0.5) / transform.width) * 2.0 - 1.0,
            (((p.y + 0.5) / transform.height) * 2.0 - 1.0) * -1.0,
            1.0,
            1.0
        ];
        vec4.transformMat4(pos, pos, this._globeProjMatrixNoCorrectionInverted);
        pos[0] /= pos[3];
        pos[1] /= pos[3];
        pos[2] /= pos[3];
        const ray: vec3 = [
            pos[0] - this._cameraPosition[0],
            pos[1] - this._cameraPosition[1],
            pos[2] - this._cameraPosition[2],
        ];
        const rayNormalized: vec3 = vec3.create();
        vec3.normalize(rayNormalized, ray);

        // Here we compute the intersection of the ray towards the pixel at `p` and the planet sphere.
        // As always, we assume that the planet is centered at 0,0,0 and has radius 1.
        // Ray origin is `_cameraPosition` and direction is `rayNormalized`.
        const rayOrigin = this._cameraPosition;
        const rayDirection = rayNormalized;

        const originDotOrigin = vec3.dot(rayOrigin, rayOrigin);
        const originDotDirection = vec3.dot(rayOrigin, rayDirection);
        const directionDotDirection = vec3.dot(rayDirection, rayDirection);
        const planetRadiusSquared = 1.0;

        // Ray-sphere intersection involves a quadratic equation ax^2 +bx + c = 0
        const a = directionDotDirection;
        const b = 2 * originDotDirection;
        const c = originDotOrigin - planetRadiusSquared;

        const d = b * b - 4.0 * a * c;

        if (d >= 0.0) {
            const sqrtD = Math.sqrt(d);
            const t0 = (-b + sqrtD) / (2.0 * a);
            const t1 = (-b - sqrtD) / (2.0 * a);
            // Assume the ray origin is never inside the sphere
            const tMin = Math.min(t0, t1);
            const intersection = vec3.create();
            vec3.add(intersection, rayOrigin, [
                rayDirection[0] * tMin,
                rayDirection[1] * tMin,
                rayDirection[2] * tMin
            ]);
            const sphereSurface = vec3.create();
            vec3.normalize(sphereSurface, intersection);
            return this._sphereSurfacePointToCoordinates(sphereSurface);
        } else {
            // Ray does not intersect the sphere -> find the closest point on the horizon to the ray.
            // Intersect the ray with the clipping plane, since we know that the intersection of the clipping plane and the sphere is the horizon.

            // dot(vec4(p,1), plane) == 0
            // dot(vec4(o+td,1), plane) == 0
            // (o.x+t*d.x)*plane.x + (o.y+t*d.y)*plane.y + (o.z+t*d.z)*plane.z + plane.w == 0
            // t*d.x*plane.x + t*d.y*plane.y + t*d.z*plane.z + dot((o,1), plane) == 0
            // t*dot(d, plane.xyz) + dot((o,1), plane) == 0
            // t*dot(d, plane.xyz) == -dot((o,1), plane)
            // t == -dot((o,1), plane) / dot(d, plane.xyz)
            const originDotPlaneXyz = this._cachedClippingPlane[0] * rayOrigin[0] + this._cachedClippingPlane[1] * rayOrigin[1] + this._cachedClippingPlane[2] * rayOrigin[2];
            const directionDotPlaneXyz = this._cachedClippingPlane[0] * rayDirection[0] + this._cachedClippingPlane[1] * rayDirection[1] + this._cachedClippingPlane[2] * rayDirection[2];
            const tPlane = -(originDotPlaneXyz + this._cachedClippingPlane[3]) / directionDotPlaneXyz;
            const planeIntersection = vec3.create();
            vec3.add(planeIntersection, rayOrigin, [
                rayDirection[0] * tPlane,
                rayDirection[1] * tPlane,
                rayDirection[2] * tPlane
            ]);
            const closestOnHorizon = vec3.create();
            vec3.normalize(closestOnHorizon, planeIntersection);

            // Now, since we want to somehow map every pixel on screen to a different coordinate,
            // add the ray from camera to horizon to the computed point,
            // multiplied by the plane intersection's distance from the planet surface.

            const toHorizon = vec3.create();
            vec3.sub(toHorizon, closestOnHorizon, rayOrigin);
            const toHorizonNormalized = vec3.create();
            vec3.normalize(toHorizonNormalized, toHorizon);

            const planeIntersectionAltitude = Math.max(vec3.length(planeIntersection) - 1.0, 0.0);

            const offsetPoint = vec3.create();
            vec3.add(offsetPoint, closestOnHorizon, [
                toHorizonNormalized[0] * planeIntersectionAltitude,
                toHorizonNormalized[1] * planeIntersectionAltitude,
                toHorizonNormalized[2] * planeIntersectionAltitude
            ]);

            const finalPoint = vec3.create();
            vec3.normalize(finalPoint, offsetPoint);

            return this._sphereSurfacePointToCoordinates(finalPoint);
        }
    }

    public getCenterForLocationAtPoint(lnglat: LngLat, point: Point, transform: Transform): LngLat {
        if (this.useGlobeControls) {
            const pointLoc = this.unprojectScreenPoint(point, transform);
            const lngDelta = pointLoc.lng - transform.center.lng;
            const latDelta = pointLoc.lat - transform.center.lat;
            const newCenter = new LngLat(
                lnglat.lng - lngDelta,
                lnglat.lat - latDelta
            );
            newCenter.wrap();
            return newCenter;
        } else {
            return this._mercator.getCenterForLocationAtPoint(lnglat, point, transform);
        }
    }
}