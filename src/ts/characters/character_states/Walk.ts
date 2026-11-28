import
{
        CharacterStateBase,
        EndWalk,
        Idle,
        JumpRunning,
        Sprint,
} from './_stateLibrary';
import { Character } from '../Character';

export class Walk extends CharacterStateBase
{
        constructor(character: Character)
        {
                super(character);

                this.canEnterVehicles = true;
                // Realism: limp when wounded. Below 50% health, walk at 70% speed; below 25%, at 40%.
                const hp = character.health;
                const speed = hp < 25 ? 0.32 : hp < 50 ? 0.56 : 0.8;
                this.character.setArcadeVelocityTarget(speed);
                this.playAnimation('walk', 0.1);
                this.scaledLoop = true;
        }

        public update(timeStep: number): void
        {
                super.update(timeStep);

                this.character.setCameraRelativeOrientationTarget();

                this.fallInAir();
        }

        public onInputChange(): void
        {
                super.onInputChange();

                if (this.noDirection())
                {
                        this.character.setState(new EndWalk(this.character));
                }

                // Realism: can't sprint when badly wounded (below 25% health)
                if (this.character.actions.run.isPressed && this.character.health >= 25)
                {
                        this.character.setState(new Sprint(this.character));
                }

                if (this.character.actions.run.justPressed && this.character.health >= 25)
                {
                        this.character.setState(new Sprint(this.character));
                }

                if (this.character.actions.jump.justPressed)
                {
                        this.character.setState(new JumpRunning(this.character));
                }

                if (this.noDirection())
                {
                        if (this.character.velocity.length() > 1)
                        {
                                this.character.setState(new EndWalk(this.character));
                        }
                        else
                        {
                                this.character.setState(new Idle(this.character));
                        }
                }
        }
}