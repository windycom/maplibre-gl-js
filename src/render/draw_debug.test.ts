import {SourceCache} from '../source/source_cache';
import {RasterSourceSpecification, SourceSpecification} from '@maplibre/maplibre-gl-style-spec';
import {Style} from '../style/style';
import {RasterStyleLayer} from '../style/style_layer/raster_style_layer';
import {selectDebugSource} from './draw_debug';

jest.mock('../style/style');

const zoom = 14;

const defaultSources: { [_: string]: SourceSpecification } = {
    'raster_tiles': {
        type: 'raster',
        maxzoom: 19,
    },
    'vector_tiles': {
        type: 'vector',
        maxzoom: 14,
    }
};

const buildMockStyle = (layers, sources = defaultSources) => {
    const style = new Style(null);
    style.sourceCaches = Object.fromEntries(
        Object.entries(sources).map(
            ([id, spec]) => [id, {id, getSource: () => spec} as SourceCache]));
    style._layers = layers;
    return style;
};

describe('selectDebugSource', () => {
    test('Decides raster if no vector source exists', () => {
        const layers = {
            '1': new RasterStyleLayer(
                {id: '1', type: 'raster', source: 'raster_tiles'}),
        };
        const mockStyle = buildMockStyle(layers);
        const source = selectDebugSource(mockStyle, zoom);
        expect(source).toHaveProperty('id', 'raster_tiles');
    });

    test('Decides on raster source with highest zoom level', () => {
        const sources: { [_: string]: RasterSourceSpecification } = {
            'raster_11': {
                type: 'raster',
                maxzoom: 11,
            },
            'raster_14': {
                type: 'raster',
                maxzoom: 14,
            }
        };
        const layers = {
            'raster_11': new RasterStyleLayer(
                {id: 'raster_11', type: 'raster', source: 'raster_11'}),
            'raster_14': new RasterStyleLayer(
                {id: 'raster_14', type: 'raster', source: 'raster_14'}),
        };
        const mockStyle = buildMockStyle(layers, sources);
        const source = selectDebugSource(mockStyle, zoom);
        expect(source).toHaveProperty('id', 'raster_14');
    });
});
