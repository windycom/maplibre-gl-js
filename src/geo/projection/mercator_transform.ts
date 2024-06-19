import {LngLat} from '../lng_lat';
import {MercatorCoordinate, mercatorXfromLng, mercatorYfromLat, mercatorZfromAltitude} from '../mercator_coordinate';
import Point from '@mapbox/point-geometry';
import {wrap, clamp} from '../../util/util';
import {mat4, vec2, vec3, vec4} from 'gl-matrix';
import {UnwrappedTileID, OverscaledTileID, CanonicalTileID} from '../../source/tile_id';
import {Terrain} from '../../render/terrain';
import {Aabb, Frustum} from '../../util/primitives';
import {interpolates} from '@maplibre/maplibre-gl-style-spec';
import {EXTENT} from '../../data/extent';
import {MAX_VALID_LATITUDE, Transform} from '../transform';
import {ProjectionData} from '../../render/program/projection_program';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units';
import {PointProjection, xyTransformMat4} from '../../symbol/projection';
import {LngLatBounds} from '../lng_lat_bounds';

export class MercatorTransform extends Transform {
    private _cameraToCenterDistance: number;
    private _cameraPosition: vec3;

    mercatorMatrix: mat4;
    projMatrix: mat4;
    invProjMatrix: mat4;
    alignedProjMatrix: mat4;
    pixelMatrix: mat4;
    pixelMatrix3D: mat4;
    pixelMatrixInverse: mat4;

    private _posMatrixCache: {[_: string]: mat4};
    private _alignedPosMatrixCache: {[_: string]: mat4};

    constructor(minZoom?: number, maxZoom?: number, minPitch?: number, maxPitch?: number, renderWorldCopies?: boolean) {
        super(minZoom, maxZoom, minPitch, maxPitch, renderWorldCopies);
        this._posMatrixCache = {};
        this._alignedPosMatrixCache = {};
    }

    public override clone(): Transform {
        const clone = new MercatorTransform(this._minZoom, this._maxZoom, this._minPitch, this.maxPitch, this._renderWorldCopies);
        clone.apply(this);
        return clone;
    }

    public override get cameraToCenterDistance(): number { return this._cameraToCenterDistance; }
    public override get cameraPosition(): vec3 { return this._cameraPosition; }

    /**
     * Return any "wrapped" copies of a given tile coordinate that are visible
     * in the current view.
     */
    override getVisibleUnwrappedCoordinates(tileID: CanonicalTileID): Array<UnwrappedTileID> {
        const result = [new UnwrappedTileID(0, tileID)];
        if (this._renderWorldCopies) {
            const utl = this.pointCoordinate(new Point(0, 0));
            const utr = this.pointCoordinate(new Point(this._width, 0));
            const ubl = this.pointCoordinate(new Point(this._width, this._height));
            const ubr = this.pointCoordinate(new Point(0, this._height));
            const w0 = Math.floor(Math.min(utl.x, utr.x, ubl.x, ubr.x));
            const w1 = Math.floor(Math.max(utl.x, utr.x, ubl.x, ubr.x));

            // Add an extra copy of the world on each side to properly render ImageSources and CanvasSources.
            // Both sources draw outside the tile boundaries of the tile that "contains them" so we need
            // to add extra copies on both sides in case offscreen tiles need to draw into on-screen ones.
            const extraWorldCopy = 1;

            for (let w = w0 - extraWorldCopy; w <= w1 + extraWorldCopy; w++) {
                if (w === 0) continue;
                result.push(new UnwrappedTileID(w, tileID));
            }
        }
        return result;
    }

    /**
     * Return all coordinates that could cover this transform for a covering
     * zoom level.
     * @param options - the options
     * @returns OverscaledTileIDs
     */
    override coveringTiles(
        options: {
            tileSize: number;
            minzoom?: number;
            maxzoom?: number;
            roundZoom?: boolean;
            reparseOverscaled?: boolean;
            renderWorldCopies?: boolean;
            terrain?: Terrain;
        }
    ): Array<OverscaledTileID> {
        let z = this.coveringZoomLevel(options);
        const actualZ = z;

        if (options.minzoom !== undefined && z < options.minzoom) return [];
        if (options.maxzoom !== undefined && z > options.maxzoom) z = options.maxzoom;

        const cameraCoord = this.pointCoordinate(this.getCameraPoint());
        const centerCoord = MercatorCoordinate.fromLngLat(this.center);
        const numTiles = Math.pow(2, z);
        const cameraPoint = [numTiles * cameraCoord.x, numTiles * cameraCoord.y, 0];
        const centerPoint = [numTiles * centerCoord.x, numTiles * centerCoord.y, 0];
        const cameraFrustum = Frustum.fromInvProjectionMatrix(this.invProjMatrix, this.worldSize, z);

        // No change of LOD behavior for pitch lower than 60 and when there is no top padding: return only tile ids from the requested zoom level
        let minZoom = options.minzoom || 0;
        // Use 0.1 as an epsilon to avoid for explicit == 0.0 floating point checks
        if (!options.terrain && this.pitch <= 60.0 && this._edgeInsets.top < 0.1)
            minZoom = z;

        // There should always be a certain number of maximum zoom level tiles surrounding the center location in 2D or in front of the camera in 3D
        const radiusOfMaxLvlLodInTiles = options.terrain ? 2 / Math.min(this.tileSize, options.tileSize) * this.tileSize : 3;

        const newRootTile = (wrap: number): any => {
            return {
                aabb: new Aabb([wrap * numTiles, 0, 0], [(wrap + 1) * numTiles, numTiles, 0]),
                zoom: 0,
                x: 0,
                y: 0,
                wrap,
                fullyVisible: false
            };
        };

        // Do a depth-first traversal to find visible tiles and proper levels of detail
        const stack = [];
        const result = [];
        const maxZoom = z;
        const overscaledZ = options.reparseOverscaled ? actualZ : z;

        if (this._renderWorldCopies) {
            // Render copy of the globe thrice on both sides
            for (let i = 1; i <= 3; i++) {
                stack.push(newRootTile(-i));
                stack.push(newRootTile(i));
            }
        }

        stack.push(newRootTile(0));

        while (stack.length > 0) {
            const it = stack.pop();
            const x = it.x;
            const y = it.y;
            let fullyVisible = it.fullyVisible;

            // Visibility of a tile is not required if any of its ancestor if fully inside the frustum
            if (!fullyVisible) {
                const intersectResult = it.aabb.intersects(cameraFrustum);

                if (intersectResult === 0)
                    continue;

                fullyVisible = intersectResult === 2;
            }

            const refPoint = options.terrain ? cameraPoint : centerPoint;
            const distanceX = it.aabb.distanceX(refPoint);
            const distanceY = it.aabb.distanceY(refPoint);
            const longestDim = Math.max(Math.abs(distanceX), Math.abs(distanceY));

            // We're using distance based heuristics to determine if a tile should be split into quadrants or not.
            // radiusOfMaxLvlLodInTiles defines that there's always a certain number of maxLevel tiles next to the map center.
            // Using the fact that a parent node in quadtree is twice the size of its children (per dimension)
            // we can define distance thresholds for each relative level:
            // f(k) = offset + 2 + 4 + 8 + 16 + ... + 2^k. This is the same as "offset+2^(k+1)-2"
            const distToSplit = radiusOfMaxLvlLodInTiles + (1 << (maxZoom - it.zoom)) - 2;

            // Have we reached the target depth or is the tile too far away to be any split further?
            if (it.zoom === maxZoom || (longestDim > distToSplit && it.zoom >= minZoom)) {
                const dz = maxZoom - it.zoom, dx = cameraPoint[0] - 0.5 - (x << dz), dy = cameraPoint[1] - 0.5 - (y << dz);
                result.push({
                    tileID: new OverscaledTileID(it.zoom === maxZoom ? overscaledZ : it.zoom, it.wrap, it.zoom, x, y),
                    distanceSq: vec2.sqrLen([centerPoint[0] - 0.5 - x, centerPoint[1] - 0.5 - y]),
                    // this variable is currently not used, but may be important to reduce the amount of loaded tiles
                    tileDistanceToCamera: Math.sqrt(dx * dx + dy * dy)
                });
                continue;
            }

            for (let i = 0; i < 4; i++) {
                const childX = (x << 1) + (i % 2);
                const childY = (y << 1) + (i >> 1);
                const childZ = it.zoom + 1;
                let quadrant = it.aabb.quadrant(i);
                if (options.terrain) {
                    const tileID = new OverscaledTileID(childZ, it.wrap, childZ, childX, childY);
                    const minMax = options.terrain.getMinMaxElevation(tileID);
                    const minElevation = minMax.minElevation ?? this.elevation;
                    const maxElevation = minMax.maxElevation ?? this.elevation;
                    quadrant = new Aabb(
                        [quadrant.min[0], quadrant.min[1], minElevation] as vec3,
                        [quadrant.max[0], quadrant.max[1], maxElevation] as vec3
                    );
                }
                stack.push({aabb: quadrant, zoom: childZ, x: childX, y: childY, wrap: it.wrap, fullyVisible});
            }
        }

        return result.sort((a, b) => a.distanceSq - b.distanceSq).map(a => a.tileID);
    }

    /**
     * Convert from LngLat to world coordinates (Mercator coordinates scaled by 512)
     * @param lnglat - the lngLat
     * @returns Point
     */
    override project(lnglat: LngLat) {
        const lat = clamp(lnglat.lat, -MAX_VALID_LATITUDE, MAX_VALID_LATITUDE);
        return new Point(
            mercatorXfromLng(lnglat.lng) * this.worldSize,
            mercatorYfromLat(lat) * this.worldSize);
    }

    /**
     * Convert from world coordinates ([0, 512],[0, 512]) to LngLat ([-180, 180], [-90, 90])
     * @param point - world coordinate
     * @returns LngLat
     */
    override unproject(point: Point): LngLat {
        return new MercatorCoordinate(point.x / this.worldSize, point.y / this.worldSize).toLngLat();
    }

    /**
     * get the camera position in LngLat and altitudes in meter
     * @returns An object with lngLat & altitude.
     */
    getCameraPosition(): {
        lngLat: LngLat;
        altitude: number;
    } {
        const lngLat = this.pointLocation(this.getCameraPoint());
        const altitude = Math.cos(this._pitch) * this._cameraToCenterDistance / this._pixelPerMeter;
        return {lngLat, altitude: altitude + this.elevation};
    }

    override recalculateZoom(terrain: Terrain): void {
        const origElevation = this.elevation;
        const origAltitude = Math.cos(this._pitch) * this._cameraToCenterDistance / this._pixelPerMeter;

        // find position the camera is looking on
        const center = this.pointLocation(this.centerPoint, terrain);
        const elevation = terrain.getElevationForLngLatZoom(center, this._tileZoom);
        const deltaElevation = this.elevation - elevation;
        if (!deltaElevation) return;

        // The camera's altitude off the ground + the ground's elevation = a constant:
        // this means the camera stays at the same total height.
        const requiredAltitude = origAltitude + origElevation - elevation;
        // Since altitude = Math.cos(this._pitch) * this.cameraToCenterDistance / pixelPerMeter:
        const requiredPixelPerMeter = Math.cos(this._pitch) * this._cameraToCenterDistance / requiredAltitude;
        // Since pixelPerMeter = mercatorZfromAltitude(1, center.lat) * worldSize:
        const requiredWorldSize = requiredPixelPerMeter / mercatorZfromAltitude(1, center.lat);
        // Since worldSize = this.tileSize * scale:
        const requiredScale = requiredWorldSize / this.tileSize;
        const zoom = this.scaleZoom(requiredScale);

        // update matrices
        this._elevation = elevation;
        this._center = center;
        this.zoom = zoom;
    }

    /**
     * Set's the transform's center so that the given point on screen is at the given world coordinates.
     * @param lnglat - Desired world coordinates of the point.
     * @param point - The screen point that should lie at the given coordinates.
     */
    override setLocationAtPoint(lnglat: LngLat, point: Point) {
        const a = this.pointCoordinate(point);
        const b = this.pointCoordinate(this.centerPoint);
        const loc = this.locationCoordinate(lnglat);
        const newCenter = new MercatorCoordinate(
            loc.x - (a.x - b.x),
            loc.y - (a.y - b.y));
        this.center = this.coordinateLocation(newCenter);
        if (this._renderWorldCopies) {
            this.center = this.center.wrap();
        }
    }

    /**
     * Given a LngLat location, return the screen point that corresponds to it
     * @param lnglat - location
     * @param terrain - optional terrain
     * @returns screen point
     */
    override locationPoint(lnglat: LngLat, terrain?: Terrain): Point {
        return terrain ?
            this.coordinatePoint(this.locationCoordinate(lnglat), terrain.getElevationForLngLatZoom(lnglat, this._tileZoom), this.pixelMatrix3D) :
            this.coordinatePoint(this.locationCoordinate(lnglat));
    }

    /**
     * Given a point on screen, return its lnglat
     * @param p - screen point
     * @param terrain - optional terrain
     * @returns lnglat location
     */
    override pointLocation(p: Point, terrain?: Terrain): LngLat {
        return this.coordinateLocation(this.pointCoordinate(p, terrain));
    }

    /**
     * Given a geographical lnglat, return an unrounded
     * coordinate that represents it at low zoom level.
     * @param lnglat - the location
     * @returns The mercator coordinate
     */
    locationCoordinate(lnglat: LngLat): MercatorCoordinate {
        return MercatorCoordinate.fromLngLat(lnglat);
    }

    /**
     * Given a Coordinate, return its geographical position.
     * @param coord - mercator coordinates
     * @returns lng and lat
     */
    coordinateLocation(coord: MercatorCoordinate): LngLat {
        return coord && coord.toLngLat();
    }

    /**
     * Given a Point, return its mercator coordinate.
     * @param p - the point
     * @param terrain - optional terrain
     * @returns lnglat
     */
    override pointCoordinate(p: Point, terrain?: Terrain): MercatorCoordinate {
        // get point-coordinate from terrain coordinates framebuffer
        if (terrain) {
            const coordinate = terrain.pointCoordinate(p);
            if (coordinate != null) {
                return coordinate;
            }
        }

        // calculate point-coordinate on flat earth
        const targetZ = 0;
        // since we don't know the correct projected z value for the point,
        // unproject two points to get a line and then find the point on that
        // line with z=0

        const coord0 = [p.x, p.y, 0, 1] as vec4;
        const coord1 = [p.x, p.y, 1, 1] as vec4;

        vec4.transformMat4(coord0, coord0, this.pixelMatrixInverse);
        vec4.transformMat4(coord1, coord1, this.pixelMatrixInverse);

        const w0 = coord0[3];
        const w1 = coord1[3];
        const x0 = coord0[0] / w0;
        const x1 = coord1[0] / w1;
        const y0 = coord0[1] / w0;
        const y1 = coord1[1] / w1;
        const z0 = coord0[2] / w0;
        const z1 = coord1[2] / w1;

        const t = z0 === z1 ? 0 : (targetZ - z0) / (z1 - z0);

        return new MercatorCoordinate(
            interpolates.number(x0, x1, t) / this.worldSize,
            interpolates.number(y0, y1, t) / this.worldSize);
    }

    /**
     * Given a coordinate, return the screen point that corresponds to it
     * @param coord - the coordinates
     * @param elevation - the elevation
     * @param pixelMatrix - the pixel matrix
     * @returns screen point
     */
    coordinatePoint(coord: MercatorCoordinate, elevation: number = 0, pixelMatrix = this.pixelMatrix): Point {
        const p = [coord.x * this.worldSize, coord.y * this.worldSize, elevation, 1] as vec4;
        vec4.transformMat4(p, p, pixelMatrix);
        return new Point(p[0] / p[3], p[1] / p[3]);
    }

    override getBounds(): LngLatBounds {
        const top = Math.max(0, this._height / 2 - this.getHorizon());
        return new LngLatBounds()
            .extend(this.pointLocation(new Point(0, top)))
            .extend(this.pointLocation(new Point(this._width, top)))
            .extend(this.pointLocation(new Point(this._width, this._height)))
            .extend(this.pointLocation(new Point(0, this._height)));
    }

    /**
     * Calculate pixel height of the visible horizon in relation to map-center (e.g. height/2),
     * multiplied by a static factor to simulate the earth-radius.
     * The calculated value is the horizontal line from the camera-height to sea-level.
     * @returns Horizon above center in pixels.
     */
    getHorizon(): number {
        return Math.tan(Math.PI / 2 - this._pitch) * this._cameraToCenterDistance * 0.85;
    }

    override isPointOnMapSurface(p: Point, terrain?: Terrain): boolean {
        if (terrain) {
            const coordinate = terrain.pointCoordinate(p);
            return coordinate != null;
        }
        return (p.y > this.height / 2 - this.getHorizon());
    }

    /**
     * Calculate the posMatrix that, given a tile coordinate, would be used to display the tile on a map.
     * This function is specific to the mercator projection.
     * @param unwrappedTileID - the tile ID
     */
    public calculatePosMatrix(unwrappedTileID: UnwrappedTileID, aligned: boolean = false): mat4 {
        const posMatrixKey = unwrappedTileID.key;
        const cache = aligned ? this._alignedPosMatrixCache : this._posMatrixCache;
        if (cache[posMatrixKey]) {
            return cache[posMatrixKey];
        }

        const canonical = unwrappedTileID.canonical;
        const scale = this.worldSize / this.zoomScale(canonical.z);
        const unwrappedX = canonical.x + Math.pow(2, canonical.z) * unwrappedTileID.wrap;

        const posMatrix = mat4.identity(new Float64Array(16) as any);
        mat4.translate(posMatrix, posMatrix, [unwrappedX * scale, canonical.y * scale, 0]);
        mat4.scale(posMatrix, posMatrix, [scale / EXTENT, scale / EXTENT, 1]);
        mat4.multiply(posMatrix, aligned ? this.alignedProjMatrix : this.projMatrix, posMatrix);

        cache[posMatrixKey] = new Float32Array(posMatrix);
        return cache[posMatrixKey];
    }

    override customLayerMatrix(): mat4 {
        return this.mercatorMatrix.slice() as any;
    }

    /**
     * Get center lngLat and zoom to ensure that
     * 1) everything beyond the bounds is excluded
     * 2) a given lngLat is as near the center as possible
     * Bounds are those set by maxBounds or North & South "Poles" and, if only 1 globe is displayed, antimeridian.
     */
    override getConstrained(lngLat: LngLat, zoom: number): {center: LngLat; zoom: number} {
        zoom = clamp(+zoom, this.minZoom, this.maxZoom);
        const result = {
            center: new LngLat(lngLat.lng, lngLat.lat),
            zoom
        };

        let lngRange = this._lngRange;

        if (!this._renderWorldCopies && lngRange === null) {
            const almost180 = 180 - 1e-10;
            lngRange = [-almost180, almost180];
        }

        const worldSize = this.tileSize * this.zoomScale(result.zoom); // A world size for the requested zoom level, not the current world size
        let minY = 0;
        let maxY = worldSize;
        let minX = 0;
        let maxX = worldSize;
        let scaleY = 0;
        let scaleX = 0;
        const {x: screenWidth, y: screenHeight} = this.size;

        if (this._latRange) {
            const latRange = this._latRange;
            minY = mercatorYfromLat(latRange[1]) * worldSize;
            maxY = mercatorYfromLat(latRange[0]) * worldSize;
            const shouldZoomIn = maxY - minY < screenHeight;
            if (shouldZoomIn) scaleY = screenHeight / (maxY - minY);
        }

        if (lngRange) {
            minX = wrap(
                mercatorXfromLng(lngRange[0]) * worldSize,
                0,
                worldSize
            );
            maxX = wrap(
                mercatorXfromLng(lngRange[1]) * worldSize,
                0,
                worldSize
            );

            if (maxX < minX) maxX += worldSize;

            const shouldZoomIn = maxX - minX < screenWidth;
            if (shouldZoomIn) scaleX = screenWidth / (maxX - minX);
        }

        const {x: originalX, y: originalY} = this.project.call({worldSize}, lngLat);
        let modifiedX, modifiedY;

        const scale = Math.max(scaleX || 0, scaleY || 0);

        if (scale) {
            // zoom in to exclude all beyond the given lng/lat ranges
            const newPoint = new Point(
                scaleX ? (maxX + minX) / 2 : originalX,
                scaleY ? (maxY + minY) / 2 : originalY);
            result.center = this.unproject.call({worldSize}, newPoint).wrap();
            result.zoom += this.scaleZoom(scale);
            return result;
        }

        if (this._latRange) {
            const h2 = screenHeight / 2;
            if (originalY - h2 < minY) modifiedY = minY + h2;
            if (originalY + h2 > maxY) modifiedY = maxY - h2;
        }

        if (lngRange) {
            const centerX = (minX + maxX) / 2;
            let wrappedX = originalX;
            if (this._renderWorldCopies) {
                wrappedX = wrap(originalX, centerX - worldSize / 2, centerX + worldSize / 2);
            }
            const w2 = screenWidth / 2;

            if (wrappedX - w2 < minX) modifiedX = minX + w2;
            if (wrappedX + w2 > maxX) modifiedX = maxX - w2;
        }

        // pan the map if the screen goes off the range
        if (modifiedX !== undefined || modifiedY !== undefined) {
            const newPoint = new Point(modifiedX ?? originalX, modifiedY ?? originalY);
            result.center = this.unproject.call({worldSize}, newPoint).wrap();
        }

        return result;
    }

    override _calcMatrices(): void {
        super._calcMatrices();

        if (!this._height) return;

        const halfFov = this._fov / 2;
        const offset = this.centerOffset;
        const point = this.project(this.center);
        const x = point.x, y = point.y;
        this._cameraToCenterDistance = 0.5 / Math.tan(halfFov) * this._height;
        this._pixelPerMeter = mercatorZfromAltitude(1, this.center.lat) * this.worldSize;

        // Calculate the camera to sea-level distance in pixel in respect of terrain
        const cameraToSeaLevelDistance = this._cameraToCenterDistance + this._elevation * this._pixelPerMeter / Math.cos(this._pitch);
        // In case of negative minimum elevation (e.g. the dead see, under the sea maps) use a lower plane for calculation
        const minElevation = Math.min(this.elevation, this.minElevationForCurrentTile);
        const cameraToLowestPointDistance = cameraToSeaLevelDistance - minElevation * this._pixelPerMeter / Math.cos(this._pitch);
        const lowestPlane = minElevation < 0 ? cameraToLowestPointDistance : cameraToSeaLevelDistance;

        // Find the distance from the center point [width/2 + offset.x, height/2 + offset.y] to the
        // center top point [width/2 + offset.x, 0] in Z units, using the law of sines.
        // 1 Z unit is equivalent to 1 horizontal px at the center of the map
        // (the distance between[width/2, height/2] and [width/2 + 1, height/2])
        const groundAngle = Math.PI / 2 + this._pitch;
        const fovAboveCenter = this._fov * (0.5 + offset.y / this._height);
        const topHalfSurfaceDistance = Math.sin(fovAboveCenter) * lowestPlane / Math.sin(clamp(Math.PI - groundAngle - fovAboveCenter, 0.01, Math.PI - 0.01));

        // Find the distance from the center point to the horizon
        const horizon = this.getHorizon();
        const horizonAngle = Math.atan(horizon / this._cameraToCenterDistance);
        const fovCenterToHorizon = 2 * horizonAngle * (0.5 + offset.y / (horizon * 2));
        const topHalfSurfaceDistanceHorizon = Math.sin(fovCenterToHorizon) * lowestPlane / Math.sin(clamp(Math.PI - groundAngle - fovCenterToHorizon, 0.01, Math.PI - 0.01));

        // Calculate z distance of the farthest fragment that should be rendered.
        // Add a bit extra to avoid precision problems when a fragment's distance is exactly `furthestDistance`
        const topHalfMinDistance = Math.min(topHalfSurfaceDistance, topHalfSurfaceDistanceHorizon);
        const farZ = (Math.cos(Math.PI / 2 - this._pitch) * topHalfMinDistance + lowestPlane) * 1.01;

        // The larger the value of nearZ is
        // - the more depth precision is available for features (good)
        // - clipping starts appearing sooner when the camera is close to 3d features (bad)
        //
        // Other values work for mapbox-gl-js but deckgl was encountering precision issues
        // when rendering custom layers. This value was experimentally chosen and
        // seems to solve z-fighting issues in deckgl while not clipping buildings too close to the camera.
        const nearZ = this._height / 50;

        // matrix for conversion from location to clip space(-1 .. 1)
        let m: mat4;
        m = new Float64Array(16) as any;
        mat4.perspective(m, this._fov, this._width / this._height, nearZ, farZ);

        // Apply center of perspective offset
        m[8] = -offset.x * 2 / this._width;
        m[9] = offset.y * 2 / this._height;

        mat4.scale(m, m, [1, -1, 1]);
        mat4.translate(m, m, [0, 0, -this._cameraToCenterDistance]);
        mat4.rotateX(m, m, this._pitch);
        mat4.rotateZ(m, m, this._angle);
        mat4.translate(m, m, [-x, -y, 0]);

        // The mercatorMatrix can be used to transform points from mercator coordinates
        // ([0, 0] nw, [1, 1] se) to clip space.
        this.mercatorMatrix = mat4.scale([] as any, m, [this.worldSize, this.worldSize, this.worldSize]);

        // scale vertically to meters per pixel (inverse of ground resolution):
        mat4.scale(m, m, [1, 1, this._pixelPerMeter]);

        // matrix for conversion from world space to screen coordinates in 2D
        this.pixelMatrix = mat4.multiply(new Float64Array(16) as any, this.clipSpaceToPixelsMatrix, m);

        // matrix for conversion from world space to clip space (-1 .. 1)
        mat4.translate(m, m, [0, 0, -this.elevation]); // elevate camera over terrain
        this.projMatrix = m;
        this.invProjMatrix = mat4.invert([] as any, m);

        const cameraPos: vec4 = [0, 0, -1, 1];
        vec4.transformMat4(cameraPos, cameraPos, this.invProjMatrix);
        this._cameraPosition = [
            cameraPos[0] / cameraPos[3],
            cameraPos[1] / cameraPos[3],
            cameraPos[2] / cameraPos[3]
        ];

        // matrix for conversion from world space to screen coordinates in 3D
        this.pixelMatrix3D = mat4.multiply(new Float64Array(16) as any, this.clipSpaceToPixelsMatrix, m);

        // Make a second projection matrix that is aligned to a pixel grid for rendering raster tiles.
        // We're rounding the (floating point) x/y values to achieve to avoid rendering raster images to fractional
        // coordinates. Additionally, we adjust by half a pixel in either direction in case that viewport dimension
        // is an odd integer to preserve rendering to the pixel grid. We're rotating this shift based on the angle
        // of the transformation so that 0°, 90°, 180°, and 270° rasters are crisp, and adjust the shift so that
        // it is always <= 0.5 pixels.
        const xShift = (this._width % 2) / 2, yShift = (this._height % 2) / 2,
            angleCos = Math.cos(this._angle), angleSin = Math.sin(this._angle),
            dx = x - Math.round(x) + angleCos * xShift + angleSin * yShift,
            dy = y - Math.round(y) + angleCos * yShift + angleSin * xShift;
        const alignedM = new Float64Array(m) as any as mat4;
        mat4.translate(alignedM, alignedM, [dx > 0.5 ? dx - 1 : dx, dy > 0.5 ? dy - 1 : dy, 0]);
        this.alignedProjMatrix = alignedM;

        // inverse matrix for conversion from screen coordinates to location
        m = mat4.invert(new Float64Array(16) as any, this.pixelMatrix);
        if (!m) throw new Error('failed to invert matrix');
        this.pixelMatrixInverse = m;

        this._posMatrixCache = {};
        this._alignedPosMatrixCache = {};
    }

    override maxPitchScaleFactor(): number {
        // calcMatrices hasn't run yet
        if (!this.pixelMatrixInverse) return 1;

        const coord = this.pointCoordinate(new Point(0, 0));
        const p = [coord.x * this.worldSize, coord.y * this.worldSize, 0, 1] as vec4;
        const topPoint = vec4.transformMat4(p, p, this.pixelMatrix);
        return topPoint[3] / this._cameraToCenterDistance;
    }

    /**
     * The camera looks at the map from a 3D (lng, lat, altitude) location. Let's use `cameraLocation`
     * as the name for the location under the camera and on the surface of the earth (lng, lat, 0).
     * `cameraPoint` is the projected position of the `cameraLocation`.
     *
     * This point is useful to us because only fill-extrusions that are between `cameraPoint` and
     * the query point on the surface of the earth can extend and intersect the query.
     *
     * When the map is not pitched the `cameraPoint` is equivalent to the center of the map because
     * the camera is right above the center of the map.
     */
    override getCameraPoint(): Point {
        const pitch = this._pitch;
        const yOffset = Math.tan(pitch) * (this._cameraToCenterDistance || 1);
        return this.centerPoint.add(new Point(0, yOffset));
    }

    /**
     * Return the distance to the camera in clip space from a LngLat.
     * This can be compared to the value from the depth buffer (terrain.depthAtPoint)
     * to determine whether a point is occluded.
     * @param lngLat - the point
     * @param elevation - the point's elevation
     * @returns depth value in clip space (between 0 and 1)
     */
    override lngLatToCameraDepth(lngLat: LngLat, elevation: number) {
        const coord = this.locationCoordinate(lngLat);
        const p = [coord.x * this.worldSize, coord.y * this.worldSize, elevation, 1] as vec4;
        vec4.transformMat4(p, p, this.projMatrix);
        return (p[2] / p[3]);
    }

    override isRenderingDirty(): boolean {
        return false;
    }

    override getProjectionData(overscaledTileID: OverscaledTileID, aligned?: boolean): ProjectionData {
        const matrix = overscaledTileID ? this.calculatePosMatrix(overscaledTileID.toUnwrapped(), aligned) : null;
        return getBasicProjectionData(overscaledTileID, matrix);
    }

    override isOccluded(_: number, __: number, ___: UnwrappedTileID): boolean {
        return false;
    }

    override getPixelScale(): number {
        return 1.0;
    }

    override getCircleRadiusCorrection(): number {
        return 1.0;
    }

    override getPitchedTextCorrection(_textAnchor: Point, _tileID: UnwrappedTileID): number {
        return 1.0;
    }

    override updateProjection(): void {
        this._calcMatrices(); // JP: TODO: really call this here?
    }

    override translatePosition(tile: { tileID: OverscaledTileID; tileSize: number }, translate: [number, number], translateAnchor: 'map' | 'viewport'): [number, number] {
        return translatePosition(this, tile, translate, translateAnchor);
    }

    override transformLightDirection(dir: vec3): vec3 {
        return vec3.clone(dir);
    }

    override projectTileCoordinates(x: number, y: number, unwrappedTileID: UnwrappedTileID, getElevation: (x: number, y: number) => number): PointProjection {
        const matrix = this.calculatePosMatrix(unwrappedTileID);
        let pos;
        if (getElevation) { // slow because of handle z-index
            pos = [x, y, getElevation(x, y), 1] as vec4;
            vec4.transformMat4(pos, pos, matrix);
        } else { // fast because of ignore z-index
            pos = [x, y, 0, 1] as vec4;
            xyTransformMat4(pos, pos, matrix);
        }
        const w = pos[3];
        return {
            point: new Point(pos[0] / w, pos[1] / w),
            signedDistanceFromCamera: w,
            isOccluded: false
        };
    }

    override precacheTiles(coords: Array<OverscaledTileID>): void {
        for (const coord of coords) {
            // Return value is thrown away, but this function will still
            // place the pos matrix into the transform's internal cache.
            this.calculatePosMatrix(coord.toUnwrapped());
        }
    }
}

/**
 * Transform a matrix to incorporate the *-translate and *-translate-anchor properties into it.
 * @param inViewportPixelUnitsUnits - True when the units accepted by the matrix are in viewport pixels instead of tile units.
 * @returns matrix
 */
export function translatePosMatrix(
    transform: { angle: number; zoom: number },
    tile: { tileID: OverscaledTileID; tileSize: number },
    matrix: mat4,
    translate: [number, number],
    translateAnchor: 'map' | 'viewport',
    inViewportPixelUnitsUnits: boolean = false
): mat4 {
    if (!translate[0] && !translate[1]) return matrix;

    const translation = translatePosition(transform, tile, translate, translateAnchor, inViewportPixelUnitsUnits);
    const translatedMatrix = new Float32Array(16);
    mat4.translate(translatedMatrix, matrix, [translation[0], translation[1], 0]);
    return translatedMatrix;
}

/**
 * Returns a translation in tile units that correctly incorporates the view angle and the *-translate and *-translate-anchor properties.
 * @param inViewportPixelUnitsUnits - True when the units accepted by the matrix are in viewport pixels instead of tile units.
 */
export function translatePosition(
    transform: { angle: number; zoom: number },
    tile: { tileID: OverscaledTileID; tileSize: number },
    translate: [number, number],
    translateAnchor: 'map' | 'viewport',
    inViewportPixelUnitsUnits: boolean = false
): [number, number] {
    if (!translate[0] && !translate[1]) return [0, 0];

    const angle = inViewportPixelUnitsUnits ?
        (translateAnchor === 'map' ? transform.angle : 0) :
        (translateAnchor === 'viewport' ? -transform.angle : 0);

    if (angle) {
        const sinA = Math.sin(angle);
        const cosA = Math.cos(angle);
        translate = [
            translate[0] * cosA - translate[1] * sinA,
            translate[0] * sinA + translate[1] * cosA
        ];
    }

    return [
        inViewportPixelUnitsUnits ? translate[0] : pixelsToTileUnits(tile, translate[0], transform.zoom),
        inViewportPixelUnitsUnits ? translate[1] : pixelsToTileUnits(tile, translate[1], transform.zoom)];
}

export function getBasicProjectionData(overscaledTileID: OverscaledTileID, tilePosMatrix?: mat4): ProjectionData {
    let tileOffsetSize: [number, number, number, number];

    if (overscaledTileID) {
        const scale = (overscaledTileID.canonical.z >= 0) ? (1 << overscaledTileID.canonical.z) : Math.pow(2.0, overscaledTileID.canonical.z);
        tileOffsetSize = [
            overscaledTileID.canonical.x / scale,
            overscaledTileID.canonical.y / scale,
            1.0 / scale / EXTENT,
            1.0 / scale / EXTENT
        ];
    } else {
        tileOffsetSize = [0, 0, 1, 1];
    }

    let mainMatrix: mat4;
    if (overscaledTileID.terrainRttPosMatrix) {
        mainMatrix = overscaledTileID.terrainRttPosMatrix;
    } else if (tilePosMatrix) {
        mainMatrix = tilePosMatrix;
    } else {
        mainMatrix = mat4.create();
    }

    const data: ProjectionData = {
        'u_projection_matrix': mainMatrix, // Might be set to a custom matrix by different projections
        'u_projection_tile_mercator_coords': tileOffsetSize,
        'u_projection_clipping_plane': [0, 0, 0, 0],
        'u_projection_transition': 0.0,
        'u_projection_fallback_matrix': mainMatrix,
    };

    return data;
}