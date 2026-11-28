import
{
        CharacterStateBase,
} from '../_stateLibrary';
import { Character } from '../../Character';
import { VehicleSeat } from 'src/ts/vehicles/VehicleSeat';
import { CloseVehicleDoorInside } from './CloseVehicleDoorInside';

export class Driving extends CharacterStateBase
{
        private seat: VehicleSeat;

        constructor(character: Character, seat: VehicleSeat)
        {
                super(character);

                this.seat = seat;
                this.canFindVehiclesToEnter = false;
                this.playAnimation('driving', 0.1);

                this.character.startControllingVehicle(seat.vehicle, this.seat);
                this.seat.vehicle.onInputChange();
                this.character.vehicleEntryInstance = null;
        }

        public update(timeStep: number): void
        {
                super.update(timeStep);

                // Realism fix: force-close the door if the player starts driving with it open.
                // Previously the door only closed when noDirectionPressed() was true, so driving
                // forward with the door open left it swinging in the wind. Now: if any movement
                // key is pressed and the door is open, force-close it immediately (no animation).
                if (this.seat.door && this.seat.door.rotation > 0.01)
                {
                        if (this.anyDirection() && !this.seat.door.achievingTargetRotation)
                        {
                                // Force-close: snap the door shut and lock physics so it can't swing open.
                                this.seat.door.close();
                        }
                }

                // Original behavior: when idling with the door open, play the close-door animation.
                if (!this.seat.door?.achievingTargetRotation && this.seat.door?.rotation > 0 && this.seat.vehicle.noDirectionPressed())
                {
                        this.character.setState(new CloseVehicleDoorInside(this.character, this.seat));
                }
        }
}