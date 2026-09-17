import { Router, type IRouter } from "express";
import memoriesRouter from "./memories";
import openaiRouter from "./openai";
import adminRouter from "./admin";
import googleRouter from "./google";
import devRouter from "./dev";
import projectsRouter from "./projects";
import toolBankRouter from "./tool-bank";
import filesRouter from "./files";

const router: IRouter = Router();

router.use(memoriesRouter);
router.use(openaiRouter);
router.use(adminRouter);
router.use(googleRouter);
router.use(devRouter);
router.use(projectsRouter);
router.use(toolBankRouter);
router.use(filesRouter);

export default router;
