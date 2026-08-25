'use client';

import { useEffect, useRef } from 'react';
import type { Rarity } from '../lib/rules';

export type ThreeStageMode = 'pack' | 'ambient' | 'showcase';
export type OpeningPhase = 'idle' | 'press' | 'charge' | 'tear' | 'flash' | 'back' | 'anticipation' | 'flip' | 'result';

const rarityColor: Record<Rarity, number> = {
  N: 0xc8c8d0,
  R: 0x65b9ee,
  SR: 0xb68aff,
  SSR: 0xffcf68,
  UR: 0xff8a54
};

export default function ThreeStage({
  mode,
  phase = 'idle',
  rarity = 'N',
  cardImage,
  onReady
}: {
  mode: ThreeStageMode;
  phase?: OpeningPhase;
  rarity?: Rarity;
  cardImage?: string;
  onReady?: (ready: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onReady?.(false);
      return;
    }

    let disposed = false;
    let visible = !document.hidden;
    let frame = 0;
    let stop: (() => void) | undefined;

    void (async () => {
      try {
        const THREE = await import('three');
        if (disposed) return;

        const renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: mode !== 'ambient',
          powerPreference: 'low-power'
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 20);
        camera.position.z = mode === 'ambient' ? 3.8 : 3.2;
        const root = new THREE.Group();
        scene.add(root);

        scene.add(new THREE.AmbientLight(0xffffff, mode === 'ambient' ? 0.35 : 1.4));
        const key = new THREE.PointLight(rarityColor[rarity], mode === 'ambient' ? 0.4 : 8, 8);
        key.position.set(1.8, 1.5, 2.8);
        scene.add(key);

        let cardPlane: InstanceType<typeof THREE.Mesh> | undefined;
        let flash: InstanceType<typeof THREE.Mesh> | undefined;
        let texture: InstanceType<typeof THREE.Texture> | undefined;

        if (mode !== 'ambient') {
          const cardMaterial = new THREE.MeshStandardMaterial({
            color: 0x17171d,
            metalness: 0.16,
            roughness: 0.48,
            transparent: true
          });
          cardPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 1.275), cardMaterial);
          cardPlane.position.z = mode === 'showcase' ? 0 : 0.18;
          cardPlane.visible = mode === 'showcase';
          root.add(cardPlane);

          if (cardImage) {
            new THREE.TextureLoader().load(
              cardImage,
              (loaded) => {
                if (disposed) return loaded.dispose();
                texture = loaded;
                loaded.colorSpace = THREE.SRGBColorSpace;
                loaded.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
                cardMaterial.map = loaded;
                cardMaterial.color.set(0xffffff);
                cardMaterial.needsUpdate = true;
              },
              undefined,
              () => onReady?.(false)
            );
          }

          const flashMaterial = new THREE.MeshBasicMaterial({
            color: rarityColor[rarity],
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
          });
          flash = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 3.8), flashMaterial);
          flash.position.z = -0.2;
          scene.add(flash);
        }

        const particleCount = mode === 'ambient' ? (innerWidth < 700 ? 42 : 72) : mode === 'pack' ? 64 : 36;
        const positions = new Float32Array(particleCount * 3);
        for (let index = 0; index < particleCount; index += 1) {
          const radius = mode === 'ambient' ? 2.8 : 1.55;
          positions[index * 3] = (Math.random() - 0.5) * radius * 2;
          positions[index * 3 + 1] = (Math.random() - 0.5) * radius * 1.5;
          positions[index * 3 + 2] = (Math.random() - 0.5) * radius;
        }
        const particleGeometry = new THREE.BufferGeometry();
        particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const particles = new THREE.Points(
          particleGeometry,
          new THREE.PointsMaterial({
            color: rarityColor[rarity],
            size: mode === 'ambient' ? 0.018 : 0.028,
            transparent: true,
            opacity: mode === 'ambient' ? 0.22 : 0.52,
            depthWrite: false,
            blending: THREE.AdditiveBlending
          })
        );
        scene.add(particles);

        const resize = () => {
          const { width, height } = canvas.getBoundingClientRect();
          if (!width || !height) return;
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvas);
        resize();

        const clock = new THREE.Clock();
        const render = () => {
          if (disposed || !visible) return;
          const time = clock.getElapsedTime();
          particles.rotation.y = time * (mode === 'ambient' ? 0.018 : 0.07);
          particles.rotation.x = Math.sin(time * 0.14) * 0.04;

          if (mode === 'ambient') {
            camera.position.x = Math.sin(time * 0.08) * 0.08;
            camera.position.y = Math.cos(time * 0.06) * 0.05;
          } else if (mode === 'showcase' && cardPlane) {
            cardPlane.rotation.y = Math.sin(time * 0.52) * 0.055;
            cardPlane.rotation.x = Math.cos(time * 0.38) * 0.025;
            cardPlane.position.y = Math.sin(time * 0.7) * 0.018;
          } else if (mode === 'pack' && cardPlane && flash) {
            const current = phaseRef.current;
            const vibrating = current === 'charge';
            root.position.x = vibrating ? Math.sin(time * 34) * 0.012 : 0;
            root.scale.setScalar(current === 'press' ? 0.95 : 1);
            root.rotation.z = Math.sin(time * 0.7) * 0.012;
            const showingCard = current === 'back' || current === 'anticipation' || current === 'flip';
            cardPlane.visible = showingCard;
            cardPlane.position.y += ((showingCard ? 0.08 : -0.42) - cardPlane.position.y) * 0.12;
            cardPlane.position.z += ((showingCard ? 0.45 : 0.18) - cardPlane.position.z) * 0.12;
            cardPlane.rotation.y += ((current === 'flip' ? 0 : Math.PI) - cardPlane.rotation.y) * 0.15;
            (flash.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity = current === 'flash'
              ? 0.72 + Math.sin(time * 20) * 0.12
              : Math.max(0, (flash.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity - 0.08);
            particles.scale.setScalar(current === 'anticipation' ? 0.72 : 1);
          }

          renderer.render(scene, camera);
          frame = requestAnimationFrame(render);
        };

        const onVisibility = () => {
          visible = !document.hidden;
          cancelAnimationFrame(frame);
          if (visible) {
            clock.getDelta();
            frame = requestAnimationFrame(render);
          }
        };
        const onContextLost = (event: Event) => {
          event.preventDefault();
          visible = false;
          cancelAnimationFrame(frame);
          onReady?.(false);
        };
        document.addEventListener('visibilitychange', onVisibility);
        canvas.addEventListener('webglcontextlost', onContextLost);
        onReady?.(true);
        frame = requestAnimationFrame(render);

        stop = () => {
          cancelAnimationFrame(frame);
          document.removeEventListener('visibilitychange', onVisibility);
          canvas.removeEventListener('webglcontextlost', onContextLost);
          resizeObserver.disconnect();
          texture?.dispose();
          scene.traverse((object) => {
            if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
            object.geometry.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
              for (const value of Object.values(material)) {
                if (value instanceof THREE.Texture) value.dispose();
              }
              material.dispose();
            }
          });
          renderer.dispose();
        };
      } catch {
        onReady?.(false);
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      stop?.();
    };
  }, [cardImage, mode, onReady, rarity]);

  return <canvas ref={canvasRef} className={`three-stage three-${mode}`} aria-hidden="true" />;
}
