import {area} from "@CoolMath/circleArea";

console.log(`When circle radius is 1, the area will be ~${area(1)}`);

/**
 * % deno run main.ts
 * When circle radius is 1, the area will be ~3.1415926
 */

/**
 * This is the ideal Deno behavior.
 * "native-deno" never needed to know the path to `@MyMath/computePi` explicitly.
 */