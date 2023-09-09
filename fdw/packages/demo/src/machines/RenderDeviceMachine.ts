import { createMachine } from 'xstate';

interface RenderDeviceContext {
  adapter: GPUAdapter | null;
  device: GPUDevice | null;
  context: GPUCanvasContext | null;
  format: GPUTextureFormat | null;
  errorMessage?: string;
}

export type InitFailedEvent = {
  type: 'Init failed';
  errorMessage: string;
};

export type AdapterReadyEvent = {
  type: 'Adapter ready';
  adapter: GPUAdapter;
};

export type DeviceReadyEvent = {
  type: 'Device ready';
  device: GPUDevice;
};

export type ContextReadyEvent = {
  type: 'Context ready';
  context: GPUCanvasContext;
};

export type DeviceConfiguredEvent = {
  type: 'Device configured';
  format: GPUTextureFormat;
};

export type RenderDeviceEvent =
  | InitFailedEvent
  | AdapterReadyEvent
  | DeviceReadyEvent
  | ContextReadyEvent
  | DeviceConfiguredEvent;

export const RenderDeviceMachine = createMachine<RenderDeviceContext>(
  {
    /** @xstate-layout N4IgpgJg5mDOIC5QCUwDsJgE4BEwDcBLAYzADo0B7AFwEk1DrCBDAG0IC9IBiexgAgBmzQq0gBtAAwBdRKAAOlWI0KU0ckAA9EARgAcATjIHJANn17JBgEzmDOgOwAaEAE9EAFlMeyHs9ckAZmsHQL0AVnCdAF9ol1QMbDwiUgoaPiY2Th4AQQhmeWpsfiwwZghXKVkkEEVlJjUNbQR9IxNzPUsbO0cXdwQ9B2MdUwczBwnA8L89WPj0TFwCEnJygqKsAHkAI2oRNB4MoRExCCqNOpVGmubwwMCyUf1Ta3C9e8CbPsQ9HTJwySAswGQJBaw6LxzEAJRbJFZkNaFbA7PaEA4Qbhw0glMoVc41S4NdQ3RB3B5PPQvN4fL5uRDWQJ-T6Mhw6AwGPxBHThKEwpLLVKYFJgFH7Q4MajHUQSGQXJRXYmgZqUyRkV6AwKmRmDDwg74IazWHwGBymN5BM33BweDy8hb84VkIUrUVongAYTURU0ktK5UqsoJ8qJTR+plV6ot2uterpCGCqpsBlML1BHkCuusdsSS0dxC9YB9rvRmIFYH4+bQgkIUAArqUzoGFMHVIqtLpwX87jpwSm+6ZKfqE8ZrMnU5J05nYnEQFRMPAanzcys5fVW6GEABaUz6zfhYzsw9Ho+BbOwstpOgSljsLgQVcKjceaz6nSOf7hdkZl7Wzq2M8OvCaIqFkHDMESABiJyQA+IYki0ki2GQViBKEkiOOmNjhPqRp6GqXJRGa4QOBEDg8jOS5Yqs+RIlsuxiveQZrtcSqIFMphkBmqEeDokhvF4nSvm+ZAQsEHjhOGho2MEAHLoKZbFjBTGPvBpj2GqXHvOyhp6F4OHTI8bKWHo4LTKybyyVRZCVt61CKYxzbMW2zS8dYeEBKCdzpuCqFDjaIkSQyUwcg4JrkfMOZWX6FSweu8EQmYZAmb8fhjD+Oh+T43KpsFHihWR07REAA */
    id: 'RenderDevice',
    predictableActionArguments: true,
    initial: 'notInitialized',
    context: {
      adapter: null,
      device: null,
      context: null,
      format: null,
    },
    schema: {
      events: {} as RenderDeviceEvent,
    },
    states: {
      notInitialized: {
        on: {
          'Init failed': {
            target: 'initializationFailed',
            actions: 'handleError',
          },
          'Adapter ready': {
            target: 'adapterObtained',
            actions: 'setAdapter',
          },
        },
      },

      initializationFailed: {},

      adapterObtained: {
        on: {
          'Init failed': {
            target: 'initializationFailed',
            actions: 'handleError',
          },
          'Device ready': { target: 'deviceObtained', actions: 'setDevice' },
        },
      },

      deviceObtained: {
        on: {
          'Init failed': {
            target: 'initializationFailed',
            actions: 'handleError',
          },
          'Context ready': { target: 'contextObtained', actions: 'setContext' },
        },
      },

      contextObtained: {
        on: {
          'Device configured': { target: 'ready', actions: 'setFormat' },
        },
      },
      ready: {},
    },
  },
  {
    actions: {
      handleError: (context: RenderDeviceContext, event: InitFailedEvent) => {
        context.errorMessage = event.errorMessage;
        console.error(event.errorMessage);
      },

      setAdapter: (context: RenderDeviceContext, event: AdapterReadyEvent) => {
        context.adapter = event.adapter;
      },

      setDevice: (context: RenderDeviceContext, event: DeviceReadyEvent) => {
        context.device = event.device;
      },

      setContext: (context: RenderDeviceContext, event: ContextReadyEvent) => {
        context.context = event.context;
      },

      setFormat: (
        context: RenderDeviceContext,
        event: DeviceConfiguredEvent
      ) => {
        context.format = event.format;
      },
    },
  }
);
