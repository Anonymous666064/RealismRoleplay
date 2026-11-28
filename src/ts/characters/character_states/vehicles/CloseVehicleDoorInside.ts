import * as THREE from 'three';
import
{
	CharacterStateBase,
} from '../_stateLibrary';
import { Character } from '../../Character';
import { VehicleSeat } from '../../../vehicles/VehicleSeat';
import { Side } from '../../../enums/Side';
import { Driving } from './Driving';
import { SeatType } from '../../../enums/SeatType';
import { Sitting } from './Sitting';
import * as Utils from '../../../core/FunctionLibrary';

export class CloseVehicleDoorInside extends CharacterStateBase
{
	private seat: VehicleSeat;
	private hasClosedDoor: boolean = false;
	private _cachedHandlePos: THREE.Vector3 = new THREE.Vector3();

	constructor(character: Character, seat: VehicleSeat)
	{
		super(character);

		this.seat = seat;
		this.canFindVehiclesToEnter = false;
		this.canLeaveVehicles = false;

		const side = Utils.detectRelativeSide(seat.seatPointObject, seat.door.doorObject);
		if (side === Side.Left)
		{
			this.playAnimation('close_door_sitting_left', 0.1);
		}
		else if (side === Side.Right)
		{
			this.playAnimation('close_door_sitting_right', 0.1);
		}
		
		this.seat.door?.open();
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);

                if (this.timer > 0.4 && !this.hasClosedDoor)
                {
                        this.hasClosedDoor = true;
                        this.seat.door?.close();
                }

                // Realism fix: reach for the door handle to pull it closed. The blend
                // ramps up before the close (reach for the handle), holds during the pull,
                // then ramps down (release after the door latches).
                if (this.seat.door)
                {
                        const handlePos = new THREE.Vector3();
                        this.seat.door.doorObject.getWorldPosition(handlePos);
                        handlePos.y += 0.3;
                        let reach = 0;
                        if (this.timer < 0.2) reach = this.timer / 0.2;
                        else if (this.timer < 0.6) reach = 1;
                        else reach = Math.max(0, 1 - (this.timer - 0.6) / 0.3);
                        this.character.reachArmToward(handlePos, reach);
                }

                if (this.animationEnded(timeStep))
		{
			if (this.seat.type === SeatType.Driver)
			{
				this.character.setState(new Driving(this.character, this.seat));
			}
			else if (this.seat.type === SeatType.Passenger)
			{
				this.character.setState(new Sitting(this.character, this.seat));
			}
		}
	}
}