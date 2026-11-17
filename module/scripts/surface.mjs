// @ts-check

/**
 * Counts the changes to what the methods offer. Raise it with every added method, parameter or result field: the
 * module names its number when it connects, and a server with a higher one refuses to work with that Foundry tab until
 * it is reloaded, instead of calling a method the tab's older module lacks or sending it a parameter it ignores.
 * A module that names no number counts as 1.
 */
export const SURFACE = 4;
