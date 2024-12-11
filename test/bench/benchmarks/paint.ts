import Benchmark from '../lib/benchmark';
import createMap from '../lib/create_map';
import type {Map} from '../../../src/ui/map';
import type {ProjectionSpecification} from '@maplibre/maplibre-gl-style-spec';

const width = 1024;
const height = 768;

export default class Paint extends Benchmark {
    style: string;
    locations: Array<any>;
    maps: Array<Map>;
    projectionType?: ProjectionSpecification['type'];

    constructor(style: string, locations: Array<any>, projectionType?: ProjectionSpecification['type']) {
        super();
        this.style = style;
        this.locations = locations;
        this.projectionType = projectionType;
    }

    async setup() {
        try {
            this.maps = await Promise.all(this.locations.map(location => {
                return createMap({
                    zoom: location.zoom,
                    width,
                    height,
                    center: location.center,
                    style: this.style,
                    projectionType: this.projectionType,
                });
            }));
        } catch (error) {
            console.error(error);
        }
    }

    bench() {
        for (const map of this.maps) {
            map._styleDirty = true;
            map._sourcesDirty = true;
            map._render(Date.now());
        }
    }

    teardown() {
        for (const map of this.maps) {
            map.remove();
        }
    }
}
