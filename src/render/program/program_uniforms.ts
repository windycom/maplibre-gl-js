import {debugUniforms} from './debug_program';
import {rasterUniforms} from './raster_program';
import {backgroundUniforms} from './background_program';
import {projectionErrorMeasurementUniforms} from './projection_error_measurement_program';
import {atmosphereUniforms} from './atmosphere_program';
import {skyUniforms} from './sky_program';

const emptyUniforms = (_: any, __: any): any => {};

export const programUniforms = {
    debug: debugUniforms,
    clippingMask: emptyUniforms,
    raster: rasterUniforms,
    background: backgroundUniforms,
    projectionErrorMeasurement: projectionErrorMeasurementUniforms,
    atmosphere: atmosphereUniforms,
    sky: skyUniforms
};
