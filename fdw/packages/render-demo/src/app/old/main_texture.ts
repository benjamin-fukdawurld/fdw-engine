import { Engine, Gpu, Program, Surface, TextureLoader } from '@fdw/render';

import { createCircleVertices, createSquareVertices, rand } from './app/utils';

import shaderCode from './assets/hardcoded.wgsl?raw';
import textureImage from './assets/f-texture.png';

async function init(engine: Engine): Promise<{
  program: Program;
}> {
  const program = new Program();
  await program.init(engine.gpu, {
    shaderDescriptor: () => ({
      label: `shaders`,
      code: shaderCode,
    }),
    pipelineDescriptor: (shaderModule: GPUShaderModule) => ({
      label: `pipeline`,
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 4 * 2 + 4, // 2 floats + 4 bytes
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
              { shaderLocation: 4, offset: 8, format: 'unorm8x4' }, // perVertexColor
            ],
          },
          {
            arrayStride: 4 * 2 + 4, // 4 + 2 floats + 4 bytes
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'unorm8x4' }, // color
              { shaderLocation: 2, offset: 4, format: 'float32x2' }, // offset
            ],
          },
          {
            arrayStride: 4 * 2, // 4 + 2 floats
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 3, offset: 0, format: 'float32x2' }, // scale
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
        targets: [{ format: engine.surface.format }],
      },
    }),
  });

  return { program };
}

function generateRenderPassDescriptor({
  surface,
}: {
  gpu: Gpu;
  surface: Surface;
  program: Program;
}): GPURenderPassDescriptor {
  return {
    label: 'our basic canvas renderPass',
    colorAttachments: [
      {
        view: surface.context.getCurrentTexture().createView(),
        clearValue: [0.3, 0.3, 0.3, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  };
}

function render(props: {
  gpu: Gpu;
  surface: Surface;
  program: Program;
  cb: (pass: GPURenderPassEncoder) => void;
}) {
  const { gpu, program, cb } = props;
  const renderPassDescriptor = generateRenderPassDescriptor(props);

  const encoder = gpu.device.createCommandEncoder({
    label: 'command-encoder',
  });

  const pass = encoder.beginRenderPass(renderPassDescriptor);
  pass.setPipeline(program.pipeline);
  cb(pass);
  pass.end();

  const commandBuffer = encoder.finish();
  gpu.device.queue.submit([commandBuffer]);
}

async function start() {
  const canvas = document.getElementById(
    'main-canvas'
  ) as HTMLCanvasElement | null;

  if (!canvas) {
    throw new Error('Canvas cannot be found');
  }

  const engine = new Engine({ label: 'fdw', canvas });
  await engine.init();
  const { program } = await init(engine);

  const constantUnitSize =
    4 + // Color
    2 * 4; // offset

  const varyingUnitSize = 2 * 4;
  // offsets to the various uniform values in float32 indices
  const kNumObjects = 100;

  const constantBufferSize = constantUnitSize * kNumObjects;
  const varyingBufferSize = varyingUnitSize * kNumObjects;

  const objectInfos: {
    scale: number;
  }[] = [];

  const constantBuffer = engine.gpu.device.createBuffer({
    label: `constant vertex for obj`,
    size: constantBufferSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  const varyingBuffer = engine.gpu.device.createBuffer({
    label: `varying vertex for obj`,
    size: varyingBufferSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  const kColorOffset = 0;
  const kOffsetOffset = 1;
  const kScaleOffset = 0;

  const constantValuesU8 = new Uint8Array(constantBufferSize);
  const constantValuesF32 = new Float32Array(constantValuesU8.buffer);
  for (let i = 0; i < kNumObjects; ++i) {
    const constantOffsetU8 = i * constantUnitSize;
    const constantOffsetF32 = constantOffsetU8 / 4;

    // set the color
    constantValuesU8.set(
      [
        rand({ min: 0.1 }) * 255,
        rand({ min: 0.1 }) * 255,
        rand({ min: 0.1 }) * 255,
        255,
      ],
      constantOffsetU8 + kColorOffset
    );

    // set the offset
    constantValuesF32.set(
      [rand({ min: -1 }), rand({ min: -1 })],
      constantOffsetF32 + kOffsetOffset
    );

    objectInfos.push({
      scale: rand({ min: 0.2, max: 0.5 }),
    });
  }
  engine.gpu.device.queue.writeBuffer(constantBuffer, 0, constantValuesF32);

  // Varying uniforms
  const varyingValues = new Float32Array(varyingBufferSize / 4);

  const { vertexData, indexData, numVertices } = createSquareVertices();

  const vertexBuffer = engine.gpu.device.createBuffer({
    label: 'vertex buffer vertices',
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  engine.gpu.device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  const indexBuffer = engine.gpu.device.createBuffer({
    label: 'index buffer',
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  engine.gpu.device.queue.writeBuffer(indexBuffer, 0, indexData);

  const texture = await engine.texLoader.loadTexture(engine.gpu, textureImage);

  const bindGroups: GPUBindGroup[] = [];
  for (let i = 0; i < 8; ++i) {
    const sampler = engine.gpu.device.createSampler({
      addressModeU: i & 1 ? 'repeat' : 'clamp-to-edge',
      addressModeV: i & 2 ? 'repeat' : 'clamp-to-edge',
      magFilter: i & 4 ? 'linear' : 'nearest',
    });

    bindGroups.push(
      engine.gpu.device.createBindGroup({
        layout: program.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: texture.createView() },
        ],
      })
    );
  }

  const settings = {
    addressModeU: 'repeat',
    addressModeV: 'repeat',
    magFilter: 'nearest',
  };

  engine.surface.onResize = () => {
    render({
      gpu: engine.gpu,
      surface: engine.surface,
      program,
      cb: (pass: GPURenderPassEncoder) => {
        const ndx =
          (settings.addressModeU === 'repeat' ? 1 : 0) +
          (settings.addressModeV === 'repeat' ? 2 : 0) +
          (settings.magFilter === 'linear' ? 4 : 0);
        const bindGroup = bindGroups[ndx];

        pass.setVertexBuffer(0, vertexBuffer);
        pass.setVertexBuffer(1, constantBuffer);
        pass.setVertexBuffer(2, varyingBuffer);
        pass.setBindGroup(0, bindGroup);
        pass.setIndexBuffer(indexBuffer, 'uint32');
        const aspect = canvas.width / canvas.height;
        const varyingStep = varyingUnitSize / 4;
        objectInfos.forEach(({ scale }, i) => {
          const offset = i * varyingStep;
          varyingValues.set([scale / aspect, scale], offset + kScaleOffset);
        });
        engine.gpu.device.queue.writeBuffer(varyingBuffer, 0, varyingValues);
        pass.drawIndexed(numVertices, kNumObjects); // call our vertex shader 3 times for each instance
      },
    });
  };
}

start();
