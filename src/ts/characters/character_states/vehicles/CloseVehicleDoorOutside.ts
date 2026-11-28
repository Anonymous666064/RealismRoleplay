import * as THREE from 'three';
import
{
	CharacterStateBase,
} from '../_stateLibrary';
import { Character } from '../../Character';
import { VehicleSeat } from '../../../vehicles/VehicleSeat';
import { Side } from '../../../enums/Side';
import { Idle } from '../Idle';
import * as Utils from '../../../core/FunctionLibrary';

export class CloseVehicleDoorOutside extends CharacterStateBase
{
	private seat: VehicleSeat;
	private hasClosedDoor: boolean = false;
	private _cachedHandlePos: THREE.Vector3 = new THREE.Vector3();

	constructor(character: Character, seat: VehicleSeat)
	{
		super(character);

		this.seat = seat;
		this.canFindVehiclesToEnter = false;

		const side = Utils.detectRelativeSide(seat.seatPointObject, seat.door.doorObject);
		if (side === Side.Left)
		{
			this.playAnimation('close_door_standing_right', 0.1);
		}
		else if (side === Side.Right)
		{
			this.playAnimation('close_door_standing_left', 0.1);
		}
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);

		if (this.timer > 0.3 && !this.hasClosedDoor)
		{
			this.hasClosedDoor = true;
			this.seat.door.close();
		}

		// Realism fix: reach for the door handle to push it closed from outside.
		if (this.seat.door)
		{
			this.seat.door.doorObject.getWorldPosition(this._cachedHandlePos);
			const handlePos = this._cachedHandlePos;
			handlePos.y += 0.3;
			let reach = 0;
			if (this.timer < 0.2) reach = this.timer / 0.2;
			else if (this.timer < 0.6) reach = 1;
			else reach = Math.max(0, 1 - (this.timer - 0.6) / 0.3);
			this.character.reachArmToward(handlePos, reach);
		}

		if (this.animationEnded(timeStep))
		{
			this.character.setState(new Idle(this.character));
			this.character.leaveSeat();
		}
	}
}