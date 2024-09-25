// Should match actual possible granularity settings from circle_bucket.ts

/**
 * Defines the granularity of subdivision for circles with `circle-pitch-alignment: 'map'` and for heatmap kernels.
 * More subdivision will cause circles to more closely follow the planet's surface.
 *
 * Possible values: 1, 3, 5, 7.
 * Subdivision of 1 results in a simple quad.
 */
export type CircleGranularity = 1 | 3 | 5 | 7;

/**
 * Controls how much subdivision happens for a given type of geometry at different zoom levels.
 */
export class SubdivisionGranularityExpression {
    /**
     * A tile of zoom level 0 will be subdivided to this granularity level.
     * Each subsequent zoom level will have its granularity halved.
     */
    private readonly _baseZoomGranularity: number;

    /**
     * No tile will have granularity level smaller than this.
     */
    private readonly _minGranularity: number;

    constructor(baseZoomGranularity: number, minGranularity: number) {
        if (minGranularity > baseZoomGranularity) {
            throw new Error('Min granularity must not be greater than base granularity.');
        }

        this._baseZoomGranularity = baseZoomGranularity;
        this._minGranularity = minGranularity;
    }

    public getGranularityForZoomLevel(zoomLevel: number): number {
        const divisor = 1 << zoomLevel;
        return Math.max(Math.floor(this._baseZoomGranularity / divisor), this._minGranularity, 1);
    }
}

/**
 * An object describing how much subdivision should be applied to different types of geometry at different zoom levels.
 */
export class SubdivisionGranularitySetting {
    /**
     * Granularity used for geometry covering the entire tile: raster tiles, etc.
     */
    public readonly tile: SubdivisionGranularityExpression;

    /**
     * Granularity used for stencil masks for tiles.
     */
    public readonly stencil: SubdivisionGranularityExpression;

    constructor(options: {
        /**
         * Granularity used for geometry covering the entire tile: stencil masks, raster tiles, etc.
         */
        tile: SubdivisionGranularityExpression;
        /**
         * Granularity used for stencil masks for tiles.
         */
        stencil: SubdivisionGranularityExpression;
    }) {
        this.tile = options.tile;
        this.stencil = options.stencil;
    }

    /**
     * Granularity settings that disable subdivision altogether.
     */
    public static readonly noSubdivision = new SubdivisionGranularitySetting({
        tile: new SubdivisionGranularityExpression(0, 0),
        stencil: new SubdivisionGranularityExpression(0, 0),
    });
}
