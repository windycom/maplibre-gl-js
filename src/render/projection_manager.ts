import {mat4, vec3} from 'gl-matrix';
import {Context} from '../gl/context';
import {Map} from '../ui/map';
import {Uniform1f, Uniform4f, UniformLocations, UniformMatrix4f} from './uniform_binding';
import {CanonicalTileID, OverscaledTileID, UnwrappedTileID} from '../source/tile_id';
import {PosArray, TriangleIndexArray} from '../data/array_types.g';
import {Mesh} from './mesh';
import {EXTENT, EXTENT_STENCIL_BORDER} from '../data/extent';
import {SegmentVector} from '../data/segment';
import posAttributes from '../data/pos_attributes';
import {Transform} from '../geo/transform';
import {Painter} from './painter';
import {Tile} from '../source/tile';
import {browser} from '../util/browser';
import {Framebuffer} from '../gl/framebuffer';
import {StencilMode} from '../gl/stencil_mode';
import {ColorMode} from '../gl/color_mode';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {DepthMode} from '../gl/depth_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {projectionErrorMeasurementUniformValues} from './program/projection_error_measurement_program';
import {warnOnce} from '../util/util';
import {mercatorYfromLat} from '../geo/mercator_coordinate';

export type ProjectionPreludeUniformsType = {
    'u_projection_matrix': UniformMatrix4f;
    'u_projection_tile_mercator_coords': Uniform4f;
    'u_projection_clipping_plane': Uniform4f;
    'u_projection_globeness': Uniform1f;
    'u_projection_fallback_matrix': UniformMatrix4f;
};

export const projectionUniforms = (context: Context, locations: UniformLocations): ProjectionPreludeUniformsType => ({
    'u_projection_matrix': new UniformMatrix4f(context, locations.u_projection_matrix),
    'u_projection_tile_mercator_coords': new Uniform4f(context, locations.u_projection_tile_mercator_coords),
    'u_projection_clipping_plane': new Uniform4f(context, locations.u_projection_clipping_plane),
    'u_projection_globeness': new Uniform1f(context, locations.u_projection_globeness),
    'u_projection_fallback_matrix': new UniformMatrix4f(context, locations.u_projection_fallback_matrix)
});

export type ProjectionData = {
    'u_projection_matrix': mat4;
    'u_projection_tile_mercator_coords': [number, number, number, number];
    'u_projection_clipping_plane': [number, number, number, number];
    'u_projection_globeness': number;
    'u_projection_fallback_matrix': mat4;
}

function clamp(a: number, min: number, max: number): number {
    return Math.min(Math.max(a, min), max);
}

function lerp(a: number, b: number, mix: number): number {
    return a * (1.0 - mix) + b * mix;
}

function smoothStep(edge0: number, edge1: number, x: number): number {
    // Function definition from GLSL: https://registry.khronos.org/OpenGL-Refpages/gl4/html/smoothstep.xhtml
    const t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

const globeTransitionTimeSeconds = 0.5;
const zoomTransitionTimeSeconds = 0.5;
const maxGlobeZoom = 12.0;
const errorTransitionTimeSeconds = 0.5;

class SubdivisionGranulitySettings {
    /**
     * A tile of zoom level 0 will be subdivided to granuality of 2 raised to this number.
     * Each subsequent zoom level will have its granuality halved.
     */
    private readonly _baseZoomGranualityPower: number;

    /**
     * No tile will have granuality smaller than 2 raised to this number.
     */
    private readonly _minGranualityPower: number;

    constructor(baseZoomGranualityPower: number, minGranualityPower: number) {
        this._baseZoomGranualityPower = baseZoomGranualityPower;
        this._minGranualityPower = minGranualityPower;
    }

    public getGranualityForZoomLevel(zoomLevel: number): number {
        return 1 << Math.max(this._baseZoomGranualityPower - zoomLevel, this._minGranualityPower, 0);
    }
}

export class ProjectionManager {
    map: Map | undefined;

    /**
     * Granuality settings used for fill layer (both polygons and their anti-aliasing outlines).
     */
    public static readonly GranualityFill = new SubdivisionGranulitySettings(7, 1);

    /**
     * Granuality used for stencil mask tiles.
     */
    public static readonly GranualityStencil = new SubdivisionGranulitySettings(7, 3);

    /**
     * Granuality used for the line layer.
     */
    public static readonly GranualityLine = new SubdivisionGranulitySettings(9, 1);

    private _tileMeshCache: {[_: string]: Mesh} = {};
    private _cachedClippingPlane: [number, number, number, number] = [1, 0, 0, 0];

    // Transition handling
    private _lastGlobeStateEnabled: boolean = false;
    private _lastGlobeChangeTime: number = -1000.0;
    private _lastLargeZoomStateChange: number = -1000.0;
    private _lastLargeZoomState: boolean = false;
    private _globeness: number;
    private _skipNextAnimation: boolean = false;

    // GPU atan() error correction
    private _errorMeasurement: ProjectionErrorMeasurement;
    private _errorQueryLatitudeDegrees: number;
    private _errorCorrectionUsable: number = 0.0;
    private _errorMeasurementLastValue: number = 0.0;
    private _errorCorrectionPreviousValue: number = 0.0;
    private _errorMeasurementLastChangeTime: number = -1000.0;

    private _globeProjMatrix: mat4 = [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ];

    /**
     * This property is true when globe rendering and globe shader variants should be in use.
     * This is false when globe is disabled, or when globe is enabled, but mercator rendering is used due to zoom level (and no transition is happening).
     */
    get useGlobeRendering(): boolean {
        return this._globeness > 0.0;
    }

    /**
     * This property is true when wrapped tiles need to be rendered.
     * This is false when globe rendering is used and no transition is happening.
     */
    get globeDrawWrappedtiles(): boolean {
        return this._globeness < 1.0;
    }

    get isRenderingDirty(): boolean {
        const now = browser.now();
        let dirty = false;
        // Globe transition
        dirty = dirty || (now - this._lastGlobeChangeTime) / 1000.0 < (Math.max(globeTransitionTimeSeconds, zoomTransitionTimeSeconds) + 0.2);
        // Error correction transition
        dirty = dirty || (now - this._errorMeasurementLastChangeTime) / 1000.0 < (errorTransitionTimeSeconds + 0.2);
        // Error correction query in flight
        dirty = dirty || this._errorMeasurement.awaitingQuery;
        return dirty;
    }

    constructor(map: Map) {
        this.map = map;
    }

    public skipNextProjectionTransitionAnimation() {
        this._skipNextAnimation = true;
    }

    public updateGPUdependent(painter: Painter): void {
        if (!this._errorMeasurement) {
            this._errorMeasurement = new ProjectionErrorMeasurement(painter);
        }
        const mercatorY = mercatorYfromLat(this._errorQueryLatitudeDegrees);
        const expectedResult = 2.0 * Math.atan(Math.exp(Math.PI - (mercatorY * Math.PI * 2.0))) - Math.PI * 0.5;
        const newValue = this._errorMeasurement.updateErrorLoop(painter, mercatorY, expectedResult);

        const now = browser.now();

        if (newValue !== this._errorMeasurementLastValue) {
            this._errorCorrectionPreviousValue = this._errorCorrectionUsable; // store the interpolated value
            this._errorMeasurementLastValue = newValue;
            this._errorMeasurementLastChangeTime = now;
        }

        const sinceUpdateSeconds = (now - this._errorMeasurementLastChangeTime) / 1000.0;
        const mix = Math.min(Math.max(sinceUpdateSeconds / errorTransitionTimeSeconds, 0.0), 1.0);
        const newCorrection = -this._errorMeasurementLastValue; // Note the negation
        this._errorCorrectionUsable = lerp(this._errorCorrectionPreviousValue, newCorrection, smoothStep(0.0, 1.0, mix));
    }

    public updateProjection(transform: Transform): void {
        this._errorQueryLatitudeDegrees = transform.center.lat;

        this._updateAnimation(transform);

        // We want zoom levels to be consistent between globe and flat views.
        // This means that the pixel size of features at the map center point
        // should be the same for both globe and flat view.
        const globeRadiusPixels = transform.worldSize / (2.0 * Math.PI) / Math.cos(transform.center.lat * Math.PI / 180);

        // Construct a completely separate matrix for globe view
        const globeMatrix = new Float64Array(16) as any;
        mat4.perspective(globeMatrix, transform._fov, transform.width / transform.height, 0.5, transform.cameraToCenterDistance + globeRadiusPixels * 2.0); // just set the far plane far enough - we will calculate our own z in the vertex shader anyway
        mat4.translate(globeMatrix, globeMatrix, [0, 0, -transform.cameraToCenterDistance]);
        mat4.rotateX(globeMatrix, globeMatrix, -transform._pitch);
        mat4.rotateZ(globeMatrix, globeMatrix, -transform.angle);
        mat4.translate(globeMatrix, globeMatrix, [0.0, 0, -globeRadiusPixels]);
        // Rotate the sphere to center it on viewed coordinates
        mat4.rotateX(globeMatrix, globeMatrix, transform.center.lat * Math.PI / 180.0 - this._errorCorrectionUsable);
        mat4.rotateY(globeMatrix, globeMatrix, -transform.center.lng * Math.PI / 180.0);
        mat4.scale(globeMatrix, globeMatrix, [globeRadiusPixels, globeRadiusPixels, globeRadiusPixels]); // Scale the unit sphere to a sphere with diameter of 1
        this._globeProjMatrix = globeMatrix;

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
        this._cachedClippingPlane = [...planeVector, -tangentPlaneDistanceToC * scale];
    }

    public getProjectionData(tileID: OverscaledTileID, fallBackMatrix?: mat4): ProjectionData {
        const identity = mat4.create();
        const data: ProjectionData = {
            'u_projection_matrix': identity,
            'u_projection_tile_mercator_coords': [0, 0, 1, 1],
            'u_projection_clipping_plane': [...this._cachedClippingPlane],
            'u_projection_globeness': this._globeness,
            'u_projection_fallback_matrix': identity,
        };

        if (tileID) {
            data['u_projection_matrix'] = fallBackMatrix ? fallBackMatrix : tileID.posMatrix;
            data['u_projection_tile_mercator_coords'] = [
                tileID.canonical.x / (1 << tileID.canonical.z),
                tileID.canonical.y / (1 << tileID.canonical.z),
                1.0 / (1 << tileID.canonical.z) / EXTENT,
                1.0 / (1 << tileID.canonical.z) / EXTENT
            ];
        }
        data['u_projection_fallback_matrix'] = data['u_projection_matrix'];

        // Set 'u_projection_matrix' to actual globe transform
        if (this.useGlobeRendering) {
            this._setGlobeProjection(data);
        }

        return data;
    }

    private _projectToSphere(mercatorX: number, mercatorY: number): vec3 {
        const sphericalX = mercatorX * Math.PI * 2.0 + Math.PI;
        const sphericalY = 2.0 * Math.atan(Math.exp(Math.PI - (mercatorY * Math.PI * 2.0))) - Math.PI * 0.5;

        const len = Math.cos(sphericalY);
        return [
            Math.sin(sphericalX) * len,
            Math.sin(sphericalY),
            Math.cos(sphericalX) * len
        ];
    }

    public isOccluded(x: number, y: number, unwrappedTileID: UnwrappedTileID): boolean {
        if (!this._isGlobeEnabled()) {
            return false;
        }

        const scale = 1.0 / (1 << unwrappedTileID.canonical.z);
        const spherePos = this._projectToSphere(
            x / EXTENT * scale + unwrappedTileID.canonical.x * scale,
            y / EXTENT * scale + unwrappedTileID.canonical.y * scale
        );
        const plane = this._cachedClippingPlane;
        // dot(position on sphere, occlusion plane equation)
        const dotResult = plane[0] * spherePos[0] + plane[1] * spherePos[1] + plane[2] * spherePos[2] + plane[3];
        return dotResult < 0.0;
    }

    public getPixelScale(transform: Transform): number {
        const globePixelScale = 1.0 / Math.cos(transform.center.lat * Math.PI / 180);
        const flatPixelScale = 1.0;
        if (this.useGlobeRendering) {
            return lerp(flatPixelScale, globePixelScale, this._globeness);
        }
        return flatPixelScale;
    }

    private _isGlobeEnabled() : boolean {
        return this.map ? this.map._globeEnabled : false;
    }

    private _updateAnimation(transform: Transform) {
        // Update globe transition animation
        const globeState = this._isGlobeEnabled();
        const currentTime = browser.now();
        if (globeState !== this._lastGlobeStateEnabled) {
            this._lastGlobeChangeTime = currentTime;
            this._lastGlobeStateEnabled = globeState;
        }
        // Transition parameter, where 0 is the start and 1 is end.
        const globeTransition = Math.min(Math.max((currentTime - this._lastGlobeChangeTime) / 1000.0 / globeTransitionTimeSeconds, 0.0), 1.0);
        this._globeness = globeState ? globeTransition : (1.0 - globeTransition);

        if (this._skipNextAnimation) {
            // Do not animate globe transition for the first 0.1 seconds of the existence of the map
            this._globeness = globeState ? 1.0 : 0.0;
            this._lastGlobeChangeTime = currentTime - globeTransitionTimeSeconds * 1000.0 * 2.0;
            this._skipNextAnimation = false;
        }

        // Update globe zoom transition
        const currentZoomState = transform.zoom >= maxGlobeZoom;
        if (currentZoomState !== this._lastLargeZoomState) {
            this._lastLargeZoomState = currentZoomState;
            this._lastLargeZoomStateChange = currentTime;
        }
        const zoomTransition = Math.min(Math.max((currentTime - this._lastLargeZoomStateChange) / 1000.0 / zoomTransitionTimeSeconds, 0.0), 1.0);
        const zoomGlobenessBound = currentZoomState ? (1.0 - zoomTransition) : zoomTransition;
        this._globeness = Math.min(this._globeness, zoomGlobenessBound);
        this._globeness = smoothStep(0.0, 1.0, this._globeness); // Smooth animation
    }

    private _setGlobeProjection(data: ProjectionData): void {
        data['u_projection_matrix'] = this._globeProjMatrix;
    }

    private _getMeshKey(granuality: number, border: boolean, north: boolean, south: boolean): string {
        return `${granuality.toString(36)}_${border ? 'b' : ''}${north ? 'n' : ''}${south ? 's' : ''}`;
    }

    public getMeshFromTileID(context: Context, canonical: CanonicalTileID, hasBorder: boolean, usePoleVertices: boolean = true): Mesh {
        const granuality = ProjectionManager.GranualityStencil.getGranualityForZoomLevel(canonical.z);
        const north = usePoleVertices && (canonical.y === 0);
        const south = usePoleVertices && (canonical.y === (1 << canonical.z) - 1);
        return this.getMesh(context, granuality, hasBorder, north, south);
    }

    public getMesh(context: Context, granuality: number, hasBorder: boolean, hasNorthEdge: boolean, hasSouthEdge: boolean): Mesh {
        const key = this._getMeshKey(granuality, hasBorder, hasNorthEdge, hasSouthEdge);

        if (key in this._tileMeshCache) {
            return this._tileMeshCache[key];
        }

        const mesh = this._createQuadMesh(context, granuality, hasBorder, hasNorthEdge, hasSouthEdge);
        this._tileMeshCache[key] = mesh;
        return mesh;
    }

    public translatePosition(painter: Painter, tile: Tile, translate: [number, number], translateAnchor: 'map' | 'viewport'): [number, number] {
        // In the future, some better translation for globe and other weird projections should be implemented here,
        // especially for the translateAnchor==='viewport' case.
        return painter.translatePosition(tile, translate, translateAnchor);
    }

    /**
     * Creates a quad mesh covering positions in range 0..EXTENT, for tile clipping.
     * @param context - MapLibre's rendering context object.
     * @param granuality - Mesh triangulation granuality: 1 for just a single quad, 3 for 3x3 quads.
     * @returns
     */
    private _createQuadMesh(context: Context, granuality: number, border: boolean, north: boolean, south: boolean): Mesh {
        const vertexArray = new PosArray();
        const indexArray = new TriangleIndexArray();

        const quadsPerAxis = border ? granuality + 2 : granuality; // two extra quads for border
        const verticesPerAxis = quadsPerAxis + 1; // one more vertex than quads

        if (border) {
            for (let y = 0; y < verticesPerAxis; y++) {
                for (let x = 0; x < verticesPerAxis; x++) {
                    let vx = (x - 1) / granuality * EXTENT;
                    if (x === 0) {
                        vx = -EXTENT_STENCIL_BORDER;
                    }
                    if (x === verticesPerAxis - 1) {
                        vx = EXTENT + EXTENT_STENCIL_BORDER;
                    }
                    let vy = (y - 1) / granuality * EXTENT;
                    if (y === 0) {
                        vy = -EXTENT_STENCIL_BORDER;
                    }
                    if (y === verticesPerAxis - 1) {
                        vy = EXTENT + EXTENT_STENCIL_BORDER;
                    }
                    vertexArray.emplaceBack(vx, vy);
                }
            }
        } else {
            for (let y = 0; y < verticesPerAxis; y++) {
                for (let x = 0; x < verticesPerAxis; x++) {
                    const vx = x / granuality * EXTENT;
                    const vy = y / granuality * EXTENT;
                    vertexArray.emplaceBack(vx, vy);
                }
            }
        }

        for (let y = 0; y < quadsPerAxis; y++) {
            for (let x = 0; x < quadsPerAxis; x++) {
                const v0 = x + y * verticesPerAxis;
                const v1 = (x + 1) + y * verticesPerAxis;
                const v2 = x + (y + 1) * verticesPerAxis;
                const v3 = (x + 1) + (y + 1) * verticesPerAxis;
                // v0----v1
                //  |  / |
                //  | /  |
                // v2----v3
                indexArray.emplaceBack(v0, v2, v1);
                indexArray.emplaceBack(v1, v2, v3);
            }
        }

        // Generate poles
        const northXY = -32768;
        const southXY = 32767;

        if (north) {
            const vNorthPole = vertexArray.length;
            vertexArray.emplaceBack(northXY, northXY);

            for (let x = 0; x < quadsPerAxis; x++) {
                const v0u = x;
                const v1u = x + 1;
                indexArray.emplaceBack(v0u, v1u, vNorthPole);
            }
        }

        if (south) {
            const vSouthPole = vertexArray.length;
            vertexArray.emplaceBack(southXY, southXY);

            for (let x = 0; x < quadsPerAxis; x++) {
                const v0u = quadsPerAxis * verticesPerAxis + x;
                const v1u = quadsPerAxis * verticesPerAxis + x + 1;
                indexArray.emplaceBack(v1u, v0u, vSouthPole);
            }
        }

        const mesh = new Mesh(
            context.createVertexBuffer(vertexArray, posAttributes.members),
            context.createIndexBuffer(indexArray),
            SegmentVector.simpleSegment(0, 0, vertexArray.length, indexArray.length)
        );

        return mesh;
    }
}

/**
 * For vector globe the vertex shader projects mercator coordinates to angluar coordinates on a sphere.
 * This projection requires some inverse trigonometry `atan(exp(...))` which is inaccurate on some GPUs (mainly on AMD and Nvidia).
 * Since the inaccuracy is hardware-dependant and may change in the future, we need to measure the error at runtime.
 *
 * Our approach relies on several assumtions:
 * - the error is only present in the "latitude" component (longitude doesn't need any inverse trigonometry)
 * - the error is continuous and changes slowly with latitude
 * - at zoom levels where the error is noticeable, the error is more-or-less the same across the entire visible map area (and thus can be described with a single number)
 *
 * Solution:
 * Every few frames, launch a GPU shader that measures the error for the current map center latitude, and writes it to a 1x1 texture.
 * Read back that texture, and offset the globe projection matrix according to the error (interpolating smoothly from old error to new error if needed).
 * The texture readback is done asynchronously using Pixel Pack Buffers (WebGL2) when possible, and has a few frames of latency, but that should not be a problem.
 */
class ProjectionErrorMeasurement {
    private readonly _ringBufferSize = 2;
    // we wait this many frames after measuring until we read back the value
    private readonly _readbackWaitFrames = 4;
    // we wait this many frames after *reading back* a measurement until we trigger measure again
    private readonly _measureWaitFrames = 4;
    private readonly _texWidth = 1;
    private readonly _texHeight = 1;
    private readonly _texFormat: number;
    private readonly _texType: number;

    private readonly _allowWebGL2 = true;

    private _fullscreenTriangle: Mesh;
    private _fbo: Framebuffer;
    private _resultBuffer: Uint8Array;
    private _pbos: Array<WebGLBuffer>;
    private _nextPboIndex = 0;

    private _measuredError: number = 0; // Result of last measurement
    private _updateCount: number = 0;
    private _lastReadbackFrame: number = -1000;

    get awaitingQuery(): boolean {
        return !!this._readbackQueue;
    }

    // There is never more than one readback waiting
    private _readbackQueue: {
        readbackIndex: number; // From what object index (in PBO ring buffer) to read data
        frameNumberIssued: number; // Framenumber when the data was first computed
        sync: WebGLSync;
    } = null;

    public constructor(painter: Painter) {
        const context = painter.context;
        const gl = context.gl;

        this._texFormat = gl.RGBA;
        this._texType = gl.UNSIGNED_BYTE;

        const vertexArray = new PosArray();
        vertexArray.emplaceBack(-1, -1);
        vertexArray.emplaceBack(2, -1);
        vertexArray.emplaceBack(-1, 2);
        const indexArray = new TriangleIndexArray();
        indexArray.emplaceBack(0, 1, 2);

        this._fullscreenTriangle = new Mesh(
            context.createVertexBuffer(vertexArray, posAttributes.members),
            context.createIndexBuffer(indexArray),
            SegmentVector.simpleSegment(0, 0, vertexArray.length, indexArray.length)
        );

        this._resultBuffer = new Uint8Array(4);

        context.activeTexture.set(gl.TEXTURE1);

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, this._texFormat, this._texWidth, this._texHeight, 0, this._texFormat, this._texType, null);

        this._fbo = context.createFramebuffer(this._texWidth, this._texHeight, false, false);
        this._fbo.colorAttachment.set(texture);

        if (this._allowWebGL2 && gl instanceof WebGL2RenderingContext) {
            this._pbos = [];

            for (let i = 0; i < this._ringBufferSize; i++) {
                const pbo = gl.createBuffer();
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
                this._pbos.push(pbo);
            }
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        }
    }

    public updateErrorLoop(painter: Painter, normalizedMercatorY: number, expectedAngleY: number): number {
        const currentFrame = this._updateCount;

        if (this._readbackQueue) {
            // Try to read back if enough frames elapsed. Otherwise do nothing, just wait another frame.
            if (currentFrame >= this._readbackQueue.frameNumberIssued + this._readbackWaitFrames) {
                // Try to read back - it is possible that this method does nothing, then
                // the readback queue will not be cleared and we will retry next frame.
                this._tryReadback(painter);
            }
        } else {
            if (currentFrame >= this._lastReadbackFrame + this._measureWaitFrames) {
                this._renderErrorTexture(painter, normalizedMercatorY, expectedAngleY);
            }
        }

        this._updateCount++;
        return this._measuredError;
    }

    private _bindFramebuffer(context: Context) {
        const gl = context.gl;
        context.activeTexture.set(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._fbo.colorAttachment.get());
        context.bindFramebuffer.set(this._fbo.framebuffer);
    }

    private _renderErrorTexture(painter: Painter, input: number, outputExpected: number): void {
        const context = painter.context;
        const gl = context.gl;

        // Update framebuffer contents
        this._bindFramebuffer(painter.context);
        context.viewport.set([0, 0, this._texWidth, this._texHeight]);
        context.clear({color: Color.transparent});

        const program = painter.useProgram('projectionErrorMeasurement');

        program.draw(context, gl.TRIANGLES,
            DepthMode.disabled, StencilMode.disabled,
            ColorMode.unblended, CullFaceMode.disabled,
            projectionErrorMeasurementUniformValues(input, outputExpected), null, null,
            '$clipping', this._fullscreenTriangle.vertexBuffer, this._fullscreenTriangle.indexBuffer,
            this._fullscreenTriangle.segments);

        context.viewport.set([0, 0, painter.width, painter.height]);

        if (this._allowWebGL2 && this._pbos && gl instanceof WebGL2RenderingContext) {
            // Read back into PBO
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbos[this._nextPboIndex]);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.readPixels(0, 0, this._texWidth, this._texHeight, this._texFormat, this._texType, 0);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();

            this._readbackQueue = {
                frameNumberIssued: this._updateCount,
                readbackIndex: this._nextPboIndex,
                sync,
            };
            this._nextPboIndex = (this._nextPboIndex + 1) % this._pbos.length;
        } else {
            // Read it back later.
            this._readbackQueue = {
                frameNumberIssued: this._updateCount,
                readbackIndex: 0,
                sync: null,
            };
        }
    }

    private _tryReadback(painter: Painter): void {
        const context = painter.context;
        const gl = context.gl;

        if (this._allowWebGL2 && this._pbos && this._readbackQueue && gl instanceof WebGL2RenderingContext) {
            // WebGL 2 path
            const waitResult = gl.clientWaitSync(this._readbackQueue.sync, 0, 0);

            if (waitResult === gl.WAIT_FAILED) {
                warnOnce('WebGL2 clientWaitSync failed.');
                this._readbackQueue = null;
                this._lastReadbackFrame = this._updateCount;
                return;
            }

            if (waitResult === gl.TIMEOUT_EXPIRED) {
                return; // Wait one more frame
            }

            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbos[this._readbackQueue.readbackIndex]);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this._resultBuffer, 0, 4);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        } else {
            // WebGL1 compatible
            this._bindFramebuffer(painter.context);
            gl.readPixels(0, 0, this._texWidth, this._texHeight, this._texFormat, this._texType, this._resultBuffer);
        }

        // If we made it here, _resultBuffer contains the new measurement
        this._readbackQueue = null;
        this._measuredError = parseRGBA8float(this._resultBuffer);
        this._lastReadbackFrame = this._updateCount;
    }
}

function parseRGBA8float(buffer: Uint8Array): number {
    let result = 0;
    result += buffer[0] / 256.0;
    result += buffer[1] / 65536.0;
    result += buffer[2] / 16777216.0;
    if (buffer[3] < 127.0) {
        result = -result;
    }
    return result / 128.0;
}