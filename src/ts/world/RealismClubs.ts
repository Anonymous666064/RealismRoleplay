/*
 * RealismClubs.ts
 * ---------------
 * Nightclubs on existing downtown commercial buildings (placed at runtime, map generation untouched):
 *
 *  - Facade: neon sign (glowing canvas plate, flickers on at night) + a door plate; by day a CLOSED plate.
 *  - "[E] Enter <club> ($fee)" (C7 owner 'illegal') between clubs.openHours (default 9 PM - 4 AM);
 *    by day "Closed, opens 9 PM". The entry fee (clubs.entryFee, cash or card) is paid once per night.
 *  - Interior (pocket room): dance floor of tiles in 4 colour groups whose emissive colours swap on the beat
 *    (4 draw calls), bar with "[E] Bar" (drinks restore thirst via realismNeeds.add('thirst', n)),
 *    DJ booth, lounge sofas, boxman dancers (pooled clones, 'dance' clip or idle + bob).
 *  - Music: procedural WebAudio beat (kick, hat, bass) scheduled ahead on the audio clock while you are
 *    inside; stops on leaving. clubs.volume 0..1 (0 = silent).
 *  - Blips (icon 'club') always shown; a guide (A15) per club.
 *
 * config clubs: { enabled, count: 2, openHours: [21, 4], entryFee: 20, volume: 0.35, dancers: 8, bpm: 124 }
 * API (world as any).realismIllegal.clubs = { list, enter(i), leave(), isOpen(), drink(i, drinkId), music }
 */

import * as THREE from 'three';
import { IllegalCore, PocketRoom, besideBuilding, reserve, textPlane, money, Site, NearSet, mergeCfg, MenuRow } from './RealismIllegalCore';
import { InteriorPlan } from './RealismBuildings';
import { REGIONS } from './RealismMapData';
import { GeoAccum, Frame, boxC } from './RealismGeometry';

export const CLUB_DEFAULTS = { enabled: true, count: 2, openHours: [21, 4], entryFee: 20, volume: 0.35, dancers: 8, bpm: 124, alwaysOpen: true, poleDancers: 3, dancerRotationMinutes: 18 };

// Realism: 5 adult-club-themed names. Colors: dark pink/purple + dark red/candy red/dark purple.
const NAMES = [
        { name: 'CRIMSON VELVET', color: '#c80a3a' },     // candy red
        { name: 'MIDNIGHT ROSE', color: '#d6336e' },     // dark pink
        { name: 'PURPLE ORCHID', color: '#7a1a9e' },     // dark purple
        { name: 'SCARLET LACE', color: '#a01030' },      // dark red
        { name: 'NEON SIREN', color: '#e63a8a' },        // pink/magenta
];
const DRINKS = [{ id: 'water', name: 'Water', price: 3, thirst: 30 }, { id: 'soda', name: 'Soda', price: 5, thirst: 25 }, { id: 'mocktail', name: 'House special', price: 14, thirst: 40 }];
// Realism: adult club neon palette -- dark pink, dark purple, candy red, dark red, magenta.
const PALETTE = [
        [0.84, 0.04, 0.23],  // candy red
        [0.84, 0.2, 0.43],  // dark pink
        [0.48, 0.1, 0.62],  // dark purple
        [0.63, 0.06, 0.19], // dark red
        [0.9, 0.23, 0.54],  // magenta/pink
];

/** Procedural beat. Pure WebAudio, scheduled on the audio clock; start/stop are idempotent. */
export class ClubMusic
{
        public playing = false;
        public notes = 0;          // scheduled notes (tests)
        public live = 0;           // nodes currently alive (tests)
        public bpm: number;
        public volume: number;
        private ac: any = null;
        private out: any = null;
        private next = 0;
        private step = 0;
        private noise: any = null;

        constructor(bpm: number, volume: number) { this.bpm = bpm; this.volume = volume; }

        public useAudioContext(ac: any): void { this.ac = ac; this.out = null; this.noise = null; }

        private ctx(): any
        {
                if (this.ac) return this.ac;
                try
                {
                        const AC = typeof window !== 'undefined' ? ((window as any).AudioContext || (window as any).webkitAudioContext) : null;
                        if (AC) this.ac = new AC();
                }
                catch (e) { this.ac = null; }
                return this.ac;
        }

        public start(): boolean
        {
                if (this.playing || this.volume <= 0) return this.playing;
                const ac = this.ctx();
                if (!ac) return false;
                try { if (ac.state === 'suspended' && ac.resume) ac.resume(); } catch (e) { /* ignore */ }
                this.out = ac.createGain();
                this.out.gain.value = this.volume;
                this.out.connect(ac.destination);
                this.playing = true;
                this.next = ac.currentTime + 0.05;
                this.step = 0;
                this.tick();
                return true;
        }

        public stop(): void
        {
                if (!this.playing) return;
                this.playing = false;
                const ac = this.ac;
                try
                {
                        this.out.gain.setValueAtTime(this.out.gain.value, ac.currentTime);
                        this.out.gain.linearRampToValueAtTime(0, ac.currentTime + 0.15);
                        const o = this.out;
                        setTimeout(() => { try { o.disconnect(); } catch (e) { /* ignore */ } }, 250);
                }
                catch (e) { /* ignore */ }
                this.out = null;
        }

        /** Schedules notes up to 0.3 s ahead. Call every frame while playing. */
        public tick(): void
        {
                if (!this.playing) return;
                const ac = this.ac;
                const s16 = 60 / this.bpm / 4;
                let guard = 0;
                while (this.next < ac.currentTime + 0.3 && guard++ < 32)
                {
                        const st = this.step % 16, t = this.next;
                        if (st % 4 === 0) this.kick(t);
                        if (st % 4 === 2) this.hat(t, 0.5);
                        if (st % 2 === 1) this.hat(t, 0.18);
                        if (st === 4 || st === 12) this.clap(t);
                        if (st % 4 === 2 || st === 15) this.bass(t, [43.65, 43.65, 51.91, 38.89][Math.floor(this.step / 16) % 4]);
                        this.next += s16;
                        this.step++;
                }
        }

        private track(n: any, end: number): void
        {
                this.live++; this.notes++;
                const done = () => { this.live = Math.max(0, this.live - 1); };
                try { n.onended = done; n.start(); n.stop(end); } catch (e) { done(); }
        }

        private env(t: number, peak: number, decay: number): any
        {
                const g = this.ac.createGain();
                g.gain.setValueAtTime(peak, t);
                g.gain.exponentialRampToValueAtTime(0.001, t + decay);
                g.connect(this.out);
                return g;
        }

        private kick(t: number): void
        {
                const ac = this.ac;
                const o = ac.createOscillator();
                o.type = 'sine';
                o.frequency.setValueAtTime(140, t);
                o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
                o.connect(this.env(t, 0.9, 0.3));
                try { o.start(t); } catch (e) { /* ignore */ }
                this.track(o, t + 0.32);
        }

        private noiseBuf(): any
        {
                if (this.noise) return this.noise;
                const ac = this.ac;
                const n = Math.floor((ac.sampleRate || 44100) * 0.2);
                const b = ac.createBuffer(1, n, ac.sampleRate || 44100);
                const d = b.getChannelData(0);
                for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
                this.noise = b;
                return b;
        }

        private hat(t: number, level: number): void
        {
                const ac = this.ac;
                const s = ac.createBufferSource();
                s.buffer = this.noiseBuf();
                const f = ac.createBiquadFilter();
                f.type = 'highpass'; f.frequency.value = 7000;
                s.connect(f); f.connect(this.env(t, level * 0.35, 0.05));
                try { s.start(t); } catch (e) { /* ignore */ }
                this.track(s, t + 0.08);
        }

        private clap(t: number): void
        {
                const ac = this.ac;
                const s = ac.createBufferSource();
                s.buffer = this.noiseBuf();
                const f = ac.createBiquadFilter();
                f.type = 'bandpass'; f.frequency.value = 1500;
                s.connect(f); f.connect(this.env(t, 0.4, 0.14));
                try { s.start(t); } catch (e) { /* ignore */ }
                this.track(s, t + 0.16);
        }

        private bass(t: number, hz: number): void
        {
                const ac = this.ac;
                const o = ac.createOscillator();
                o.type = 'sawtooth';
                o.frequency.setValueAtTime(hz * 2, t);
                const f = ac.createBiquadFilter();
                f.type = 'lowpass'; f.frequency.value = 380;
                o.connect(f); f.connect(this.env(t, 0.35, 0.22));
                try { o.start(t); } catch (e) { /* ignore */ }
                this.track(o, t + 0.24);
        }
}

export interface Club
{
        index: number;
        name: string;
        color: string;
        building: number;
        site: Site;
        room: PocketRoom;
        tileMats: THREE.MeshLambertMaterial[];
        neon: THREE.Mesh;
        closedPlate: THREE.Mesh;
        paidNight: number;
        dancers: THREE.Object3D[];
        // Realism: pole dancer system
        poleDancers: THREE.Object3D[];   // figures on the stage poles
        poles: THREE.Object3D[];         // the pole meshes (for positioning)
        activePoleDancer: number;        // index of the currently dancing pole dancer
        dancerTimer: number;             // seconds since last rotation
        neonLights: THREE.PointLight[];  // neon point lights inside the club
        spotlights: THREE.SpotLight[];   // spotlights above the stage
        buildingObj?: any;               // the building data (for inside-check)
}


// Realism: create 2 NEW club buildings (not reuse existing). Called before BuildingBuilder.
export function assignClubs(data: any): any[]
{
	const out: any[] = [];
	// Two club locations spread around the city:
	// 1. Near downtown / east side
	// 2. Near the port / Harbor Row area
	const sites = [
		{ x: 300, z: 200, rot: 0 },
		{ x: 650, z: 350, rot: Math.PI },
	];
	for (let si = 0; si < sites.length; si++)
	{
		const s = sites[si];
		// Measure ground height at the site
		const gY = data.heightAt(s.x, s.z);
		const b: any = {
			x: s.x, z: s.z, w: 24, d: 20, h: 8, rot: s.rot,
			baseY: gY - 0.8, groundY: gY,
			style: 'plain', tint: [0.12, 0.08, 0.15],
			roof: 'flat', roofTint: [0.08, 0.05, 0.1],
			collide: true, kind: 'office', enterable: true,
			id: data.buildings.length,
			custom: 'club', role: 'club',
			label: si === 0 ? 'CRIMSON VELVET' : 'MIDNIGHT ROSE',
			closed: false, boarded: false,
			condition: 1, district: undefined,
		};
		b.fixedBase = true;
		data.buildings.push(b);
		out.push(b);
		// Clear trees / props on the lot
		const c = Math.cos(s.rot), sn = Math.sin(s.rot);
		const inside = (x: number, z: number) =>
		{
			const dx = x - s.x, dz = z - s.z;
			return Math.abs(dx * c - dz * sn) < 14 && Math.abs(dx * sn + dz * c) < 14;
		};
		data.trees = (data.trees || []).filter((t: any) => !inside(t.x, t.z));
		data.lamps = (data.lamps || []).filter((t: any) => !inside(t.x, t.z));
		data.props = (data.props || []).filter((t: any) => !inside(t.x, t.z));
	}
	console.log('[Realism] Clubs created: ' + out.length + ' new buildings');
	return out;
}

export class Clubs
{
        public api: any;
        public cfg: any;
        public list: Club[] = [];
        public music: ClubMusic;
        public lightSwaps = 0;
        public drinks = 0;
        private core: IllegalCore;
        private near = new NearSet();
        private beatT = 0;
        private beat = 0;
        private acc = 1;
        private wasOpen: boolean = null;
        private tmp = new THREE.Vector3();

        constructor(core: IllegalCore)
        {
                this.core = core;
                this.cfg = mergeCfg(CLUB_DEFAULTS, (core.ctx.cfg as any).clubs || ((typeof window !== 'undefined' && (window as any).REALISM_CONFIG) ? (window as any).REALISM_CONFIG.clubs : null));
                this.music = new ClubMusic(this.cfg.bpm, this.cfg.volume);
                const self = this;
                this.api = {
                        get list(): any[] { return self.describe(); },
                        enter(i: number): boolean { return self.enter(i, true); },
                        leave(): void { const c = self.inside(); if (c) c.room.leave(true); },
                        isOpen(): boolean { return self.isOpen(); },
                        drink(i: number, id: string): boolean { return self.drink(i, id); },
                        music: this.music,
                };
                if (!this.cfg.enabled) return;
                this.place();
                core.addUpdater(this);
        }

        public isOpen(): boolean
        {
                return true;  // Realism: clubs always open
        }

        public inside(): Club
        {
                const pp = this.core.w.camera ? this.core.w.camera.position : null;
                if (!pp) return null;
                for (let i = 0; i < this.list.length; i++)
                {
                        const c = this.list[i];
                        const b = (c as any).buildingObj;
                        if (!b) continue;
                        if (Math.abs(pp.x - b.x) < b.w / 2 + 1 && Math.abs(pp.z - b.z) < b.d / 2 + 1) return c;
                }
                return null;
        }

        // ------------------------------------------------------------------ placement

        private place(): void
	{
		const bs: any[] = this.core.ctx.data.buildings;
		const want = Math.max(0, Math.min(NAMES.length, Math.round(this.cfg.count)));
		for (let i = 0; i < bs.length && this.list.length < want; i++)
		{
			if (bs[i].custom !== 'club') continue;
			this.build(i);
		}
	}

	
	private build(bi: number): void
	{
		const core = this.core;
		const ctx = core.ctx;
		const b: any = ctx.data.buildings[bi];
		const idx = this.list.length;
		const nm = NAMES[idx % NAMES.length];
		const gw = core.w.graphicsWorld;
		const baseY = b.baseY || 0;
		const gY = b.groundY !== undefined ? b.groundY : baseY + 0.8;
		const floorY = gY + 0.18;
		const W = b.w, D = b.d, hw = W / 2, hd = D / 2;
		const H = b.h;  // building height
		const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
		// Helper: convert local (lx, ly, lz) to world
		const wp = (lx: number, ly: number, lz: number): [number, number, number] =>
			[b.x + lx * c + lz * s, floorY + ly, b.z - lx * s + lz * c];
		// Helper: add a box mesh to the world (NO NearSet -- always visible)
		const box = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, color: number, collide = false) =>
		{
			const p = wp(lx, ly, lz);
			const mesh = new THREE.Mesh(
				new THREE.BoxBufferGeometry(sx, sy, sz),
				new THREE.MeshLambertMaterial({ color })
			);
			mesh.position.set(p[0], p[1], p[2]);
			mesh.rotation.y = b.rot || 0;
			gw.add(mesh);
			if (collide) ctx.bphys.box(p[0], p[1], p[2], sx / 2, sy / 2, sz / 2, b.rot || 0);
			return mesh;
		};
		// Helper: add a cylinder
		const cyl = (lx: number, ly: number, lz: number, r: number, h: number, color: number, segments = 12) =>
		{
			const p = wp(lx, ly, lz);
			const mesh = new THREE.Mesh(
				new THREE.CylinderGeometry(r, r, h, segments),
				new THREE.MeshLambertMaterial({ color })
			);
			mesh.position.set(p[0], p[1], p[2]);
			gw.add(mesh);
			return mesh;
		};

		// ---- SHELL: floor, walls, ceiling ----
		const wallCol = 0x1a0a1a, floorCol = 0x0a0508, ceilCol = 0x0a0508;
		// Floor
		box(0, -0.18, 0, W, 0.18, D, floorCol, true);
		// Ceiling
		box(0, H - floorY + baseY - 0.1, 0, W, 0.1, D, ceilCol, true);
		// 4 walls (with door openings at front +z and back -z)
		const wallH = H - floorY + baseY - 0.28;
		const wallY = wallH / 2;
		const doorW = 2.0;
		// front wall (+z): split into 2 segments around the door
		box(-hw - doorW / 2 + (hw - doorW / 2) / 2 - 0.5, wallY, hd, hw - doorW / 2, wallH, 0.2, wallCol, true);
		box(hw + doorW / 2 - (hw - doorW / 2) / 2 + 0.5, wallY, hd, hw - doorW / 2, wallH, 0.2, wallCol, true);
		// back wall (-z): split around back door
		box(-hw - doorW / 2 + (hw - doorW / 2) / 2 - 0.5, wallY, -hd, hw - doorW / 2, wallH, 0.2, wallCol, true);
		box(hw + doorW / 2 - (hw - doorW / 2) / 2 + 0.5, wallY, -hd, hw - doorW / 2, wallH, 0.2, wallCol, true);
		// side walls (-x and +x): solid
		box(-hw, wallY, 0, 0.2, wallH, D, wallCol, true);
		box(hw, wallY, 0, 0.2, wallH, D, wallCol, true);
		// Board up all windows (wooden boards on the outside of each wall)
		const boardMat = new THREE.MeshLambertMaterial({ color: 0x2a1a0a });
		for (let fi = 0; fi < 6; fi++)
		{
			const by = 1.0 + fi * 1.2;
			// front and back walls
			for (const fz of [hd + 0.02, -hd - 0.02])
			{
				const p = wp(0, by, fz);
				const board = new THREE.Mesh(new THREE.BoxBufferGeometry(W - 1, 0.6, 0.04), boardMat);
				board.position.set(p[0], p[1], p[2]); board.rotation.y = b.rot || 0;
				gw.add(board);
			}
			// side walls
			for (const fx of [-hw - 0.02, hw + 0.02])
			{
				const p = wp(fx, by, 0);
				const board = new THREE.Mesh(new THREE.BoxBufferGeometry(0.04, 0.6, D - 1), boardMat);
				board.position.set(p[0], p[1], p[2]); board.rotation.y = b.rot || 0;
				gw.add(board);
			}
		}

		// ---- ENTRANCE: barriers, red carpet, canopy, bouncer ----
		const entryZ = hd + 1.5;
		// Gold barrier poles
		for (const px of [-1.5, 1.5])
		{
			cyl(px, 0.5, entryZ, 0.04, 1.0, 0xd4af37, 8);
			// velvet rope
			const rp = wp(px, 0.95, entryZ);
			const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 3.0, 4), new THREE.MeshBasicMaterial({ color: 0x8a0a3a }));
			rope.position.set(rp[0], rp[1], rp[2]); rope.rotation.z = Math.PI / 2; rope.rotation.y = b.rot || 0;
			gw.add(rope);
		}
		// Red carpet
		const cp = wp(0, 0.01, entryZ - 0.5);
		const carpet = new THREE.Mesh(new THREE.PlaneBufferGeometry(3.5, 3.0), new THREE.MeshLambertMaterial({ color: 0x5a0a1a }));
		carpet.rotation.x = -Math.PI / 2; carpet.position.set(cp[0], cp[1], cp[2]); carpet.rotation.z = b.rot || 0;
		gw.add(carpet);
		// Canopy: 4 posts + sloped roof with neon edge
		const canopyY = baseY + 3.0, cpostH = canopyY - baseY;
		for (const cpx of [-1.8, 1.8]) for (const cpz of [entryZ - 1, entryZ + 1])
		{
			const p = wp(cpx, cpostH / 2, cpz);
			const post = new THREE.Mesh(new THREE.BoxBufferGeometry(0.08, cpostH, 0.08), new THREE.MeshLambertMaterial({ color: 0x1a1a1a }));
			post.position.set(p[0], p[1], p[2]); post.rotation.y = b.rot || 0;
			gw.add(post);
		}
		const crp = wp(0, canopyY, entryZ);
		const canopyRoof = new THREE.Mesh(new THREE.BoxBufferGeometry(4.2, 0.1, 2.4), new THREE.MeshLambertMaterial({ color: 0x0a0a0a, emissive: new THREE.Color(nm.color).multiplyScalar(0.2) }));
		canopyRoof.position.set(crp[0], crp[1], crp[2]); canopyRoof.rotation.x = -0.08; canopyRoof.rotation.z = b.rot || 0;
		gw.add(canopyRoof);
		// Neon sign above the door
		const neonY = baseY + Math.min(Math.max(3.6, H - 1.2), 6);
		const neon = textPlane(nm.name, 5, nm.color, 'rgba(8,6,14,0.0)', true);
		(neon.material as THREE.MeshBasicMaterial).transparent = true;
		const np = wp(0, neonY, hd + 0.15);
		neon.position.set(np[0], np[1], np[2]); neon.rotation.y = b.rot || 0;
		gw.add(neon);
		// Bouncer figure outside the entrance
		const bwp = wp(0, 0, entryZ + 0.5);
		const bouncer = core.figure(bwp[0], bwp[1], bwp[2], b.rot || 0, [0.05, 0.05, 0.06], 'idle', gw);
		bouncer.userData.isBouncer = true;
		// Neon light outside
		const olp = wp(0, baseY + 2.5, hd + 1);
		const ol = new THREE.PointLight(new THREE.Color(nm.color).getHex(), 1.5, 12, 2);
		ol.position.set(olp[0], olp[1], olp[2]);
		gw.add(ol);

		// ---- INTERIOR: 3 circular stages in a triangle ----
		const stageR = 2.0, stageH = 0.35;
		// Triangle vertices (local coords, centered in the building)
		const triR = 3.5;  // triangle radius
		const stages = [
			{ x: 0, z: triR },                    // top
			{ x: -triR * 0.866, z: -triR * 0.5 },  // bottom left
			{ x: triR * 0.866, z: -triR * 0.5 },   // bottom right
		];
		const polePositions = stages;  // one pole on each stage
		const poles: THREE.Object3D[] = [];
		const poleDancers: THREE.Object3D[] = [];
		for (let si = 0; si < 3; si++)
		{
			const st = stages[si];
			// Circular stage platform
			cyl(st.x, stageH / 2, st.z, stageR, stageH, 0x1a0508, 24);
			// Red stage top
			cyl(st.x, stageH + 0.01, st.z, stageR - 0.05, 0.02, 0x4a0510, 24);
			// Pole on the stage
			const pp = wp(st.x, stageH + 1.4, st.z);
			const pole = new THREE.Mesh(
				new THREE.CylinderGeometry(0.04, 0.04, 2.8, 8),
				new THREE.MeshPhongMaterial({ color: 0xcccccc, shininess: 100, emissive: new THREE.Color(0.3, 0.1, 0.2), emissiveIntensity: 0.3 })
			);
			pole.position.set(pp[0], pp[1], pp[2]);
			gw.add(pole);
			poles.push(pole);
			// Pole base plate
			cyl(st.x, stageH + 0.02, st.z, 0.15, 0.04, 0x222222, 12);
			// Spotlight above the stage
			const slp = wp(st.x, H - floorY + baseY - 0.5, st.z);
			const sl = new THREE.SpotLight([0xff3df0, 0x7a1a9e, 0xc80a3a][si], 2, 10, Math.PI / 6, 0.4, 1.5);
			sl.position.set(slp[0], slp[1], slp[2]);
			const slt = wp(st.x, stageH, st.z);
			sl.target.position.set(slt[0], slt[1], slt[2]);
			sl.castShadow = false;
			gw.add(sl); gw.add(sl.target);
			// Dancer on the stage (female model)
			const dwp = wp(st.x, stageH, st.z);
			const dancer = core.figure(dwp[0], dwp[1], dwp[2], 0, PALETTE[si % PALETTE.length].map((v: number) => v * 0.8), 'dance', gw);
			dancer.userData.poleX = st.x; dancer.userData.poleZ = st.z;
			dancer.userData.phase = Math.random() * Math.PI * 2;
			dancer.visible = si === 0;  // only first dancer visible initially
			poleDancers.push(dancer);
		}
		// Connecting walkways between stages (the triangle edges)
		for (let ei = 0; ei < 3; ei++)
		{
			const a = stages[ei], b2 = stages[(ei + 1) % 3];
			const mx = (a.x + b2.x) / 2, mz = (a.z + b2.z) / 2;
			const dx = b2.x - a.x, dz = b2.z - a.z;
			const len = Math.hypot(dx, dz);
			const ang = Math.atan2(dz, dx);
			// Walkway as a flat box
			const wlp = wp(mx, 0.02, mz);
			const walk = new THREE.Mesh(new THREE.BoxBufferGeometry(len, 0.04, 1.0), new THREE.MeshLambertMaterial({ color: 0x2a0a14 }));
			walk.position.set(wlp[0], wlp[1], wlp[2]);
			walk.rotation.y = (b.rot || 0) + ang;
			gw.add(walk);
		}
		// Lane from the triangle to the back rooms (-z direction)
		box(0, 0.02, -triR - 2, 1.2, 0.04, 4.0, 0x2a0a14);

		// ---- BAR (along the left wall, -x side) ----
		box(-hw + 1.5, 0.55, 0, 1.0, 1.1, 8, 0x221008, true);
		box(-hw + 1.5, 1.12, 0, 1.1, 0.06, 8.2, 0x553322);
		box(-hw + 1.2, 1.5, 0, 0.5, 2.0, 8, 0x1a1008, true);
		// Bar stools
		for (let bi2 = 0; bi2 < 5; bi2++)
		{
			const sz = -3 + bi2 * 1.5;
			box(-hw + 2.8, 0.4, sz, 0.35, 0.8, 0.35, 0x1a1008);
			const swp = wp(-hw + 2.8, 0.55, sz);
			core.figure(swp[0], swp[1], swp[2], 0, PALETTE[bi2 % PALETTE.length].map((v: number) => v * 0.65), 'sitting', gw);
		}

		// ---- VIP ROOM (right side, +x) ----
		const vipX = hw - 4;
		// VIP partition walls
		box(vipX - 2.5, 1.0, 0, 0.1, 2.0, 6, 0x1a0a14, true);  // left wall
		box(vipX, 1.0, 3, 5, 2.0, 0.1, 0x1a0a14, true);  // back wall
		box(vipX, 1.0, -3, 5, 2.0, 0.1, 0x1a0a14, true);  // front wall
		// VIP booths
		for (let vi = 0; vi < 3; vi++)
		{
			const vz = -2 + vi * 2;
			box(vipX - 1, 0.55, vz, 1.2, 0.5, 0.8, 0x4a0520, true);
			box(vipX - 0.5, 1.0, vz, 0.8, 0.6, 0.2, 0x3a0418);
			const vwp = wp(vipX - 1, 0.65, vz);
			core.figure(vwp[0], vwp[1], vwp[2], (b.rot || 0) + Math.PI / 2, PALETTE[vi % PALETTE.length].map((v: number) => v * 0.7), 'sitting', gw);
		}
		// VIP label
		const vipL = textPlane('VIP', 1.5, '#ffd27f');
		const vlp = wp(vipX - 2, 2.0, 0);
		vipL.position.set(vlp[0], vlp[1], vlp[2]); vipL.rotation.y = (b.rot || 0) + Math.PI / 2;
		gw.add(vipL);

		// ---- CASHIER at the entrance ----
		box(0, 0.55, hd - 2.5, 2.5, 1.1, 0.6, 0x1a1008, true);
		box(0, 1.12, hd - 2.5, 2.6, 0.06, 0.7, 0x332210);
		const cwp = wp(0, 0.55, hd - 3.0);
		const cashier = core.figure(cwp[0], cwp[1], cwp[2], (b.rot || 0) + Math.PI, [0.05, 0.02, 0.08], 'idle', gw);
		cashier.userData.isCashier = true;

		// ---- DJ BOOTH (back corner, -x -z) ----
		box(-hw + 2, 0.6, -hd + 2, 1.4, 1.2, 1.4, 0x121212, true);
		box(-hw + 2, 1.25, -hd + 2.1, 0.7, 0.1, 0.7, 0x333333);

		// ---- DANCE FLOOR (center, between the stages) ----
		const dfp = wp(0, 0.01, 0);
		const danceFloor = new THREE.Mesh(
			new THREE.CircleBufferGeometry(triR - 0.5, 24),
			new THREE.MeshLambertMaterial({ color: 0x1a1a22, emissive: new THREE.Color(nm.color).multiplyScalar(0.15) })
		);
		danceFloor.rotation.x = -Math.PI / 2;
		danceFloor.position.set(dfp[0], dfp[1], dfp[2]);
		danceFloor.rotation.z = b.rot || 0;
		gw.add(danceFloor);
		// Dance floor dancers
		const dancers: THREE.Object3D[] = [];
		const nDancers = Math.max(0, Math.min(8, Math.round(this.cfg.dancers)));
		for (let i = 0; i < nDancers; i++)
		{
			const a = i / Math.max(1, nDancers) * Math.PI * 2;
			const r = 1.2;
			const dx = Math.cos(a) * r, dz = Math.sin(a) * r;
			const dwp2 = wp(dx, 0, dz);
			dancers.push(core.figure(dwp2[0], dwp2[1], dwp2[2], a + Math.PI, PALETTE[(i + 2) % PALETTE.length].map((v: number) => v * 0.6), 'dance', gw));
		}

		// ---- TABLES + SITTING NPCs ----
		for (let ti = 0; ti < 4; ti++)
		{
			const tx = -4 + (ti % 2) * 8, tz = 5 + Math.floor(ti / 2) * 3;
			box(tx, 0.4, tz, 1.2, 0.8, 1.2, 0x1a0a08, true);
			const twp = wp(tx, 0.5, tz + 0.8);
			core.figure(twp[0], twp[1], twp[2], (b.rot || 0) + Math.PI, PALETTE[ti % PALETTE.length].map((v: number) => v * 0.6), 'sitting', gw);
		}

		// ---- NEON LIGHTS (inside) ----
		const neonLights: THREE.PointLight[] = [];
		const neonLocal = [[-hw + 2, 2.5, -hd + 2], [hw - 2, 2.5, -hd + 2], [-hw + 2, 2.5, hd - 2], [hw - 2, 2.5, hd - 2], [0, 3, 0]];
		const neonColors = [0xd6336e, 0x7a1a9e, 0xc80a3a, 0xe63a8a, 0xa01030];
		for (let ni = 0; ni < neonLocal.length; ni++)
		{
			const nlp = wp(neonLocal[ni][0], neonLocal[ni][1], neonLocal[ni][2]);
			const nl = new THREE.PointLight(neonColors[ni], 1.0, 12, 2);
			nl.position.set(nlp[0], nlp[1], nlp[2]);
			nl.castShadow = false;
			gw.add(nl);
			neonLights.push(nl);
		}
		const spotlights: THREE.SpotLight[] = [];  // (added per-stage above, stored here)
		// Note: spotlights were created per-stage above; collect them via the poles array
		// (each pole has a spotlight above it; we stored 3 spotlights in the stage loop)

		// ---- SECOND FLOOR: BOSS OFFICE above the club ----
		const floor2Y = 4.0;  // height of the second floor above the club floor
		const officeW = 10, officeD = 8;
		const officeX = 0, officeZ = 0;
		// Second floor platform (glass floor -- mirror effect: see down but they can't see up)
		const ofp = wp(officeX, floor2Y, officeZ);
		const glassFloor = new THREE.Mesh(
			new THREE.PlaneBufferGeometry(officeW, officeD),
			new THREE.MeshPhysicalMaterial({
				color: 0x0a0a0a, metalness: 0.4, roughness: 0.05,
				transparent: true, opacity: 0.35, side: THREE.DoubleSide,
				emissive: new THREE.Color(0.05, 0.01, 0.04), emissiveIntensity: 0.2,
			})
		);
		glassFloor.rotation.x = -Math.PI / 2;
		glassFloor.position.set(ofp[0], ofp[1], ofp[2]);
		glassFloor.rotation.z = b.rot || 0;
		gw.add(glassFloor);
		// Physics: add a thin box collider for the second floor
		ctx.bphys.box(ofp[0], ofp[1] - 0.05, ofp[2], officeW / 2, 0.05, officeD / 2, b.rot || 0);
		// Office walls (half-height partitions around the glass floor)
		const owH = 2.5;
		box(officeX - officeW / 2, floor2Y + owH / 2, officeZ, 0.15, owH, officeD, 0x1a0a1a, true);  // left
		box(officeX + officeW / 2, floor2Y + owH / 2, officeZ, 0.15, owH, officeD, 0x1a0a1a, true);  // right
		box(officeX, floor2Y + owH / 2, officeZ - officeD / 2, officeW, owH, 0.15, 0x1a0a1a, true);  // back
		// Front wall with a door opening (for the staircase)
		box(officeX - officeW / 2 + 1.5, floor2Y + owH / 2, officeZ + officeD / 2, 3, owH, 0.15, 0x1a0a1a, true);
		box(officeX + officeW / 2 - 1.5, floor2Y + owH / 2, officeZ + officeD / 2, 3, owH, 0.15, 0x1a0a1a, true);
		// Staircase from club floor to the office (simple ramp)
		const stairSteps = 8;
		for (let si2 = 0; si2 < stairSteps; si2++)
		{
			const stepY = (si2 / stairSteps) * floor2Y;
			const stepZ = officeZ + officeD / 2 + 0.5 + si2 * 0.3;
			box(officeX, stepY, stepZ, 1.5, 0.1, 0.3, 0x1a1a1a, true);
		}
		// Office furniture: desk, chair, lamp, laptop
		box(officeX - 3, floor2Y + 0.5, officeZ - 2, 1.6, 1.0, 0.8, 0x1a0a08, true);  // desk
		box(officeX - 3, floor2Y + 1.02, officeZ - 2, 1.7, 0.04, 0.9, 0x2a1a10);  // desk top
		box(officeX - 3, floor2Y + 0.4, officeZ - 1, 0.5, 0.8, 0.5, 0x0a0a0a);  // chair
		box(officeX - 3.5, floor2Y + 1.1, officeZ - 2, 0.4, 0.02, 0.3, 0x222222);  // laptop
		box(officeX - 2, floor2Y + 1.5, officeZ - 2, 0.15, 0.3, 0.15, 0x444422);  // lamp
		// Bed
		box(officeX + 3, floor2Y + 0.3, officeZ - 2, 1.5, 0.5, 2.0, 0x2a1a1a, true);  // bed frame
		box(officeX + 3, floor2Y + 0.6, officeZ - 2, 1.4, 0.15, 1.9, 0x4a3a3a);  // mattress
		box(officeX + 3, floor2Y + 0.8, officeZ - 2.8, 1.4, 0.3, 0.5, 0x3a2a2a);  // pillow
		// Two side tables + lamps
		for (const sdx of [2.0, 4.0])
		{
			box(officeX + sdx, floor2Y + 0.3, officeZ - 2, 0.4, 0.6, 0.4, 0x1a0a08, true);
			box(officeX + sdx, floor2Y + 1.0, officeZ - 2, 0.1, 0.3, 0.1, 0x444422);  // lamp
		}
		// Bathroom (corner)
		box(officeX + officeW / 2 - 1.5, floor2Y + 1.0, officeZ + officeD / 2 - 1.5, 0.1, 2.0, 3, 0x1a1a1a, true);  // bathroom wall
		box(officeX + officeW / 2 - 2, floor2Y + 0.4, officeZ + officeD / 2 - 1, 0.6, 0.3, 0.6, 0x333333, true);  // toilet
		box(officeX + officeW / 2 - 2, floor2Y + 0.5, officeZ + officeD / 2 - 2.5, 1.2, 0.5, 0.6, 0x222222, true);  // sink counter
		// Closet (wall of shelves)
		box(officeX - officeW / 2 + 1, floor2Y + 1.0, officeZ + officeD / 2 - 1, 0.3, 2.0, 2.0, 0x2a1a0a, true);
		// Safe room (empty room with shelves + racks)
		box(officeX - officeW / 2 + 0.5, floor2Y + 1.0, officeZ - officeD / 2 + 1.5, 2.5, 2.0, 0.15, 0x2a2a2a, true);  // safe room back wall
		box(officeX - officeW / 2 + 0.5, floor2Y + 1.0, officeZ - officeD / 2 + 0.3, 0.15, 2.0, 2.5, 0x2a2a2a, true);  // safe room side wall
		// Safe room shelves + racks
		for (let ri = 0; ri < 3; ri++)
		{
			box(officeX - officeW / 2 + 1.2, floor2Y + 0.3 + ri * 0.6, officeZ - officeD / 2 + 1, 1.5, 0.04, 0.4, 0x1a1a1a, true);
		}
		// Boss NPC sitting at the desk
		const bwp2 = wp(officeX - 3, floor2Y + 0.65, officeZ - 1);
		core.figure(bwp2[0], bwp2[1], bwp2[2], (b.rot || 0) + Math.PI, [0.08, 0.05, 0.06], 'sitting', gw);
		// Office neon light
		const onlp = wp(officeX, floor2Y + 1.5, officeZ);
		const onl = new THREE.PointLight(0xd6336e, 0.5, 8, 2);
		onl.position.set(onlp[0], onlp[1], onlp[2]);
		gw.add(onl);
		neonLights.push(onl);

		// ---- BACK DOOR EXIT (at the -z wall) ----
		const exitWp = wp(0, 0, -hd - 0.5);
		core.add({ id: 'club_exit_' + idx, x: exitWp[0], y: exitWp[1], z: exitWp[2], r: 2.0, mode: 'foot',
			items: () => [{ key: 'E', label: 'Back door exit' }], act: () => { this.core.toast('You leave through the back door.'); } });

		// ---- CLUB OBJECT ----
		const club: Club = { index: idx, name: nm.name, color: nm.color, building: bi, site: { x: b.x, y: baseY, z: b.z, rot: b.rot || 0 } as Site, room: null as any, tileMats: [], neon: neon, closedPlate: null as any, paidNight: -1, dancers: dancers, poleDancers: poleDancers, poles: poles, activePoleDancer: 0, dancerTimer: 0, neonLights: neonLights, spotlights: spotlights, buildingObj: b };
		this.list.push(club);
		core.addBlip('ill_club_' + idx, { x: b.x, z: b.z, icon: 'club', color: nm.color, label: nm.name + ' (nightclub)', always: true });
		// Entry interactable at the front door
		const doorWp = wp(0, 0, hd + 0.5);
		core.add({ id: 'club_door_' + idx, x: doorWp[0], y: doorWp[1], z: doorWp[2], r: 3.0, mode: 'foot',
			items: () => [{ key: 'E', label: this.fee(club) > 0 ? 'Pay entry (' + money(this.fee(club)) + ')' : 'Welcome to ' + nm.name }],
			act: () => { this.enter(idx, false); } });
		// Bar interactable
		const barWp = wp(-hw + 2.5, 0, 0);
		core.add({ id: 'club_bar_' + idx, x: barWp[0], y: barWp[1], z: barWp[2], r: 2.4, mode: 'foot', items: () => [{ key: 'E', label: 'Bar' }], act: () => this.openBar(idx) });
	}

	
	private openLabel(): string { const h = this.cfg.openHours[0]; return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); }

        private night(): number { return Math.floor(((this.core.state.clock || 0) + 12) / 24); }

        private fee(c: Club): number { return c.paidNight === this.night() ? 0 : Math.max(0, this.cfg.entryFee || 0); }

        // ------------------------------------------------------------------ actions

        public enter(i: number, force: boolean): boolean
        {
                const c = this.list[i];
                if (!c) return false;
                // Realism: always open, no time check
                const fee = this.fee(c);
                if (fee > 0)
                {
                        if (!this.core.pay(fee, c.name + ' entry', c.name)) { this.core.toast('Entry is ' + money(fee) + '. Pay the cashier.'); return false; }
                        c.paidNight = this.night();
                        this.core.toast('Paid ' + money(fee) + ' to the cashier. Welcome to ' + c.name + '.');
                }
                return true;  // Realism: no teleport -- walk through the door
        }

        public drink(i: number, id: string): boolean
        {
                const c = this.list[i];
                const d = DRINKS.filter((x) => x.id === id)[0];
                if (!c || !d) return false;
                if (!this.core.pay(d.price, d.name + ' at ' + c.name, c.name)) { this.core.toast('Not enough money.'); return false; }
                const n = (this.core.w as any).realismNeeds;
                try { if (n && typeof n.add === 'function') n.add('thirst', d.thirst); } catch (e) { /* ignore */ }
                this.drinks++;
                this.core.toast(d.name + '. Refreshing.');
                return true;
        }

        private openBar(i: number): void
        {
                const c = this.list[i];
                this.core.menu({
                        title: c.name + ' - BAR', subtitle: 'Drinks restore thirst.',
                        rows: () => DRINKS.map((d) => ({ label: d.name, detail: '+' + d.thirst + ' thirst', right: money(d.price), action: () => this.drink(i, d.id) } as MenuRow)),
                });
        }

        // ------------------------------------------------------------------ frame

        public update(dt: number): void
        {
                const c = this.inside();
                if (c)
                {
                        this.music.tick();
                        this.beatT += dt;
                        const beatLen = 60 / this.cfg.bpm;
                        if (this.beatT >= beatLen)
                        {
                                this.beatT -= beatLen;
                                if (this.beatT > beatLen) this.beatT = 0;
                                this.beat++;
                                for (let k = 0; k < c.tileMats.length; k++)
                                {
                                        const p = PALETTE[(k + this.beat) % PALETTE.length];
                                        const on = ((k + this.beat) % 3) !== 0;
                                        c.tileMats[k].emissive.setRGB(p[0] * (on ? 1 : 0.15), p[1] * (on ? 1 : 0.15), p[2] * (on ? 1 : 0.15));
                                }
                                this.lightSwaps++;
                        }
                        // Realism: procedural pole dancer animation + rotation.
                        // Each active dancer does a simplified pole routine: walk around the pole,
                        // hip sway, arm reach up to grab the pole, occasional spin. Tasteful, aesthetic.
                        this.updatePoleDancers(c, dt);
                }
                else if (this.music.playing) this.music.stop();
                this.acc += dt;
                if (this.acc < 0.5) return;
                this.acc = 0;
                const open = this.isOpen();
                if (open !== this.wasOpen)
                {
                        this.wasOpen = open;
                        for (let i = 0; i < this.list.length; i++)
                        {
                                const cl = this.list[i];
                                (cl.neon.material as THREE.MeshBasicMaterial).color.setScalar(open ? 1 : 0.25);
                                if (cl.closedPlate) cl.closedPlate.userData.hidden = open;  // null-safe (clubs have no closed plate)
                        }
                }
                if (this.core.playerPos(this.tmp)) this.near.update(this.tmp);
        }

        /** Realism: procedural pole dancer animation + rotation.
         * Each active dancer does a simplified pole routine: walk around the pole, hip sway,
         * arm reach up, occasional spin. Every dancerRotationMinutes (game time), the active
         * dancer walks off and the next one walks on. Tasteful, aesthetic -- no explicit content. */
        private updatePoleDancers(c: Club, dt: number): void
        {
                if (!c.poleDancers || c.poleDancers.length === 0) return;
                c.dancerTimer += dt;
                // Rotation: every dancerRotationMinutes (default 18) of real time, switch dancers.
                const rotSec = (this.cfg.dancerRotationMinutes || 18) * 60;
                if (c.dancerTimer >= rotSec)
                {
                        c.dancerTimer = 0;
                        const old = c.activePoleDancer;
                        c.poleDancers[old].visible = false;
                        c.activePoleDancer = (old + 1) % c.poleDancers.length;
                        c.poleDancers[c.activePoleDancer].visible = true;
                }
                // Animate the active dancer
                const d = c.poleDancers[c.activePoleDancer];
                if (!d || !d.visible) return;
                const phase = (d.userData.phase || 0) + dt * 0.8;  // procedural dance speed
                d.userData.phase = phase;
                const px = d.userData.poleX, pz = d.userData.poleZ;
                // Walk around the pole: orbit at radius 0.6m
                const orbitR = 0.6;
                const ox = px + Math.cos(phase) * orbitR;
                const oz = pz + Math.sin(phase) * orbitR;
                d.position.x = c.room.x + ox;
                d.position.z = c.room.z + oz;
                d.position.y = c.room.y + 0.4;  // stage height
                // Face toward the pole
                d.rotation.y = phase + Math.PI;
                // Hip sway: rotate the root slightly side to side
                d.rotation.z = Math.sin(phase * 2) * 0.08;
                // Arm reach: every ~4 seconds, reach up (rotate the model back slightly)
                const reachCycle = Math.sin(phase * 1.5);
                d.rotation.x = Math.max(0, reachCycle) * 0.15;  // lean back slightly on reach
                // Subtle vertical bob (rhythm)
                d.position.y += Math.abs(Math.sin(phase * 4)) * 0.05;
        }

        public describe(): any[]
        {
                const bs: any[] = this.core.ctx.data.buildings;
                return this.list.map((c) => ({ name: c.name, building: c.building, kind: bs[c.building].kind, label: bs[c.building].label || '', door: { x: +c.site.x.toFixed(1), z: +c.site.z.toFixed(1) }, dancers: c.dancers.length }));
        }
}
