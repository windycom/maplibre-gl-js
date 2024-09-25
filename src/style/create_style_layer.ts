import {BackgroundStyleLayer} from './style_layer/background_style_layer';
import {RasterStyleLayer} from './style_layer/raster_style_layer';
import {CustomStyleLayer, type CustomLayerInterface} from './style_layer/custom_style_layer';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';

export function createStyleLayer(layer: LayerSpecification | CustomLayerInterface) {
    if (layer.type === 'custom') {
        return new CustomStyleLayer(layer);
    }
    switch (layer.type) {
        case 'background':
            return new BackgroundStyleLayer(layer);
        case 'raster':
            return new RasterStyleLayer(layer);
    }
}

