declare module "@earendil-works/pi-ai" {
	export const StringEnum: any;
}

declare module "typebox" {
	export const Type: any;
}

declare module "@earendil-works/pi-tui" {
	export interface Component {
		render(width: number): string[];
		handleInput?(data: string): void;
		invalidate(): void;
	}

	export interface Focusable {
		focused: boolean;
	}

	export class Input implements Component, Focusable {
		focused: boolean;
		onSubmit?: (value: string) => void;
		onEscape?: () => void;
		getValue(): string;
		setValue(value: string): void;
		handleInput(data: string): void;
		render(width: number): string[];
		invalidate(): void;
	}

	export function getKeybindings(): { matches(data: string, binding: string): boolean };
	export function truncateToWidth(text: string, width: number, ellipsis?: string): string;
	export function visibleWidth(text: string): number;
}
